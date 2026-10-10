#!/usr/bin/env python3
"""Fetch public draw records from the same endpoints used by dhlottery.co.kr.

No dependencies, credentials, browser proxy, or invented fallback numbers.
"""
import argparse
from concurrent.futures import ThreadPoolExecutor, as_completed
from datetime import date, datetime, timedelta, timezone
import json
from pathlib import Path
import sys
import time
from urllib.parse import urlencode
from urllib.request import Request, urlopen

ROOT = Path(__file__).resolve().parents[1]
DATA = ROOT / 'dist' / 'data'
FIRST_DATE = date(2002, 12, 7)
ORIGIN = 'https://www.dhlottery.co.kr'
RESULT_PAGE = ORIGIN + '/lt645/result'
LATEST_ENDPOINT = ORIGIN + '/lt645/selectPstLt645Info.do'
BATCH_ENDPOINT = ORIGIN + '/lt645/selectPstLt645InfoNew.do'


def stamp():
    return datetime.now(timezone.utc).isoformat(timespec='seconds')


def get_json(url, params=None):
    if params:
        url += '?' + urlencode(params)
    headers = {'User-Agent': 'Mozilla/5.0 LottoLab/1.0',
               'Accept': 'application/json', 'Referer': RESULT_PAGE}
    for attempt in range(3):
        try:
            with urlopen(Request(url, headers=headers), timeout=25) as response:
                payload = json.load(response)
            rows = payload.get('data', {}).get('list')
            if not isinstance(rows, list) or not rows:
                raise ValueError('Official response contains no draw records')
            return [normalize(row) for row in rows]
        except Exception:
            if attempt == 2:
                raise
            time.sleep(1 + attempt)


def normalize(row):
    raw_date = str(row['ltRflYmd']).replace('-', '')
    if len(raw_date) != 8:
        raise ValueError('Invalid official draw date')
    return {'round': int(row['ltEpsd']),
            'date': f'{raw_date[:4]}-{raw_date[4:6]}-{raw_date[6:]}',
            'numbers': sorted(int(row[f'tm{i}WnNo']) for i in range(1, 7)),
            'bonus': int(row['bnsWnNo'])}


def validate(draws):
    if not draws:
        raise ValueError('Empty data is not usable')
    for expected, row in enumerate(draws, 1):
        if row['round'] != expected:
            raise ValueError(f'Missing or duplicate round: expected {expected}')
        numbers = row['numbers']
        if len(numbers) != 6 or len(set(numbers)) != 6:
            raise ValueError(f'Duplicate or missing main numbers in round {expected}')
        if any(type(n) is not int or not 1 <= n <= 45 for n in numbers):
            raise ValueError(f'Invalid main number in round {expected}')
        if numbers != sorted(numbers):
            raise ValueError(f'Unsorted main numbers in round {expected}')
        if type(row['bonus']) is not int or not 1 <= row['bonus'] <= 45 or row['bonus'] in numbers:
            raise ValueError(f'Invalid bonus in round {expected}')
        if date.fromisoformat(row['date']) != FIRST_DATE + timedelta(weeks=expected - 1):
            raise ValueError(f'Unexpected draw date in round {expected}')
        if date.fromisoformat(row['date']) > datetime.now(timezone(timedelta(hours=9))).date():
            raise ValueError(f'Future draw in round {expected}')
    return True


def write(payload):
    DATA.mkdir(parents=True, exist_ok=True)
    compact = json.dumps(payload, ensure_ascii=False, separators=(',', ':'))
    files = {'lotto.json': compact + '\n',
             'lotto-data.js': '/* Official main numbers; bonus excluded from recommendation statistics. */\nwindow.LOTTO_DATA=' + compact + ';\n'}
    for name, contents in files.items():
        tmp = DATA / (name + '.tmp')
        tmp.write_text(contents, encoding='utf-8')
        tmp.replace(DATA / name)


def update(bootstrap=False):
    path = DATA / 'lotto.json'
    original = json.loads(path.read_text(encoding='utf-8')) if path.exists() else None
    if not original and not bootstrap:
        raise ValueError('No existing dataset: run with --bootstrap to fetch from round 1')
    if original:
        validate(original['draws'])
    latest_records = get_json(LATEST_ENDPOINT)
    latest = max(row['round'] for row in latest_records)
    old_latest = original['draws'][-1]['round'] if original else 0
    if latest < old_latest:
        raise ValueError(f'Official latest round {latest} would shrink the existing history {old_latest}')
    records = {row['round']: row for row in (original['draws'] if original else [])}

    def merge(rows):
        for row in rows:
            if row['round'] in records and records[row['round']] != row:
                raise ValueError(f'Conflicting official record for round {row["round"]}; review before updating')
            records[row['round']] = row

    merge(latest_records)
    # Same public GET request and paging semantics as the official results page.
    recent = get_json(BATCH_ENDPOINT, {'srchDir': 'center', 'srchLtEpsd': latest})
    merge(recent)
    cursor = min(row['round'] for row in recent)
    if bootstrap and not original:
        # At most 3 concurrent requests; 10 draws per request.
        cursors = list(range(cursor, 1, -10))
        with ThreadPoolExecutor(max_workers=3) as pool:
            pending = {pool.submit(get_json, BATCH_ENDPOINT,
                                  {'srchDir': 'older', 'srchCursorLtEpsd': c}): c
                       for c in cursors}
            for index, future in enumerate(as_completed(pending), 1):
                merge(future.result())
                if index % 10 == 0 or index == len(pending):
                    print(f'Collected {len(records)}/{latest} official draw records', flush=True)
    else:
        while cursor > old_latest + 1:
            batch = get_json(BATCH_ENDPOINT, {'srchDir': 'older', 'srchCursorLtEpsd': cursor})
            next_cursor = min(row['round'] for row in batch)
            if next_cursor >= cursor:
                raise ValueError('Official paging did not progress')
            merge(batch)
            cursor = next_cursor
    draws = [records[r] for r in sorted(records)]
    validate(draws)
    if draws[-1]['round'] != latest:
        raise ValueError('Latest official draw is missing')
    now = stamp()
    metadata = {'schemaVersion': 1, 'sourceName': '동행복권',
                'sourceUrl': RESULT_PAGE, 'sourceEndpoints': [LATEST_ENDPOINT, BATCH_ENDPOINT],
                'firstRound': 1, 'lastRound': latest, 'totalDraws': len(draws),
                'updatedAt': now if latest != old_latest or not original else original['metadata']['updatedAt'],
                'checkedAt': now, 'updateState': 'ok', 'complete': True,
                'mainNumbersOnly': True}
    write({'metadata': metadata, 'draws': draws})
    print(f'Validated official rounds 1–{latest}: {len(draws)} draws, {len(draws) * 6} main numbers', flush=True)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--bootstrap', action='store_true', help='Initial full-history collection')
    parser.add_argument('--validate-only', action='store_true')
    args = parser.parse_args()
    if args.validate_only:
        payload = json.loads((DATA / 'lotto.json').read_text(encoding='utf-8'))
        validate(payload['draws'])
        print(f'Valid contiguous history: {len(payload["draws"])} draws')
        return
    try:
        update(args.bootstrap)
    except Exception as exc:
        # Keep every verified draw and record the failure honestly.
        path = DATA / 'lotto.json'
        if path.exists():
            previous = json.loads(path.read_text(encoding='utf-8'))
            validate(previous['draws'])
            previous['metadata'].update(checkedAt=stamp(), updateState='failed')
            write(previous)
        print(f'Update failed; verified history preserved: {exc}', file=sys.stderr)
        sys.exit(1)


if __name__ == '__main__':
    main()
