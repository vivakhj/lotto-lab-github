import importlib.util
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location('lotto_updater', ROOT / 'scripts' / 'update_lotto.py')
updater = importlib.util.module_from_spec(spec)
spec.loader.exec_module(updater)


class UpdaterTest(unittest.TestCase):
    def setUp(self):
        self.payload = json.loads((ROOT / 'dist' / 'data' / 'lotto.json').read_text(encoding='utf-8'))

    def test_full_history_and_missing_round(self):
        self.assertTrue(updater.validate(self.payload['draws']))
        with self.assertRaisesRegex(ValueError, 'Missing'):
            updater.validate(self.payload['draws'][1:])

    def test_official_schema_and_bonus_validation(self):
        row = {'ltEpsd': 1, 'ltRflYmd': '20021207', 'bnsWnNo': 16,
               **{f'tm{i}WnNo': n for i, n in enumerate([10, 23, 29, 33, 37, 40], 1)}}
        self.assertEqual(updater.normalize(row), self.payload['draws'][0])
        bad = json.loads(json.dumps(self.payload['draws']))
        bad[0]['bonus'] = 10
        with self.assertRaisesRegex(ValueError, 'bonus'):
            updater.validate(bad)

    def test_official_failure_keeps_every_verified_record(self):
        with tempfile.TemporaryDirectory() as folder:
            target = Path(folder)
            with patch.object(updater, 'DATA', target):
                updater.write(self.payload)
                with patch.object(updater, 'get_json', side_effect=OSError('official endpoint unavailable')):
                    with patch('sys.argv', ['update_lotto.py']), self.assertRaises(SystemExit) as raised:
                        updater.main()
                    self.assertEqual(raised.exception.code, 1)
                after = json.loads((target / 'lotto.json').read_text(encoding='utf-8'))
                self.assertEqual(after['draws'], self.payload['draws'])
                self.assertEqual(after['metadata']['updateState'], 'failed')
                self.assertEqual(after['metadata']['updatedAt'], self.payload['metadata']['updatedAt'])

    def test_success_checks_latest_again_without_dropping_history(self):
        latest = self.payload['draws'][-1]
        with tempfile.TemporaryDirectory() as folder:
            with patch.object(updater, 'DATA', Path(folder)):
                updater.write(self.payload)
                with patch.object(updater, 'get_json', return_value=[latest]):
                    updater.update()
                after = json.loads((Path(folder) / 'lotto.json').read_text(encoding='utf-8'))
                self.assertEqual(after['draws'], self.payload['draws'])
                self.assertEqual(after['metadata']['updateState'], 'ok')


if __name__ == '__main__':
    unittest.main()
