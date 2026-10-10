'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const C = require('../dist/lotto-core.js');
const payload = require('../dist/data/lotto.json');
const stats = C.analyze(payload);
function seeded(seed = 82731) {
  return () => { seed = (Math.imul(1664525, seed) + 1013904223) >>> 0; return seed / 4294967296; };
}

test('data is complete from round 1; all-number totals exclude bonus', () => {
  assert.equal(C.validatePayload(payload), true);
  assert.deepEqual(payload.draws[0].numbers, [10, 23, 29, 33, 37, 40]);
  assert.equal(payload.draws[0].date, '2002-12-07');
  assert.equal(stats.allCounts.reduce((a, b) => a + b, 0), stats.total * 6);
  assert.equal(stats.recentCounts.reduce((a, b) => a + b, 0), stats.recentTotal * 6);
  const first = { metadata: { firstRound: 1, lastRound: 1, totalDraws: 1, complete: true }, draws: [payload.draws[0]] };
  const one = C.analyze(first);
  assert.equal(one.allCounts[16], 0); // Round 1's bonus must not enter main-number stats.
  assert.equal(one.allCounts[10], 1);
});

test('missing rounds, invalid dates and duplicate numbers fail closed', () => {
  const missing = structuredClone(payload); missing.draws.splice(10, 1);
  assert.throws(() => C.validatePayload(missing), /누락/);
  const duplicate = structuredClone(payload); duplicate.draws[0].numbers[1] = 10;
  assert.throws(() => C.validatePayload(duplicate), /당첨번호/);
  const wrongDate = structuredClone(payload); wrongDate.draws[0].date = '2002-12-08';
  assert.throws(() => C.validatePayload(wrongDate), /추첨일/);
  const bonus = structuredClone(payload); bonus.draws[0].bonus = 10;
  assert.throws(() => C.validatePayload(bonus), /보너스/);
});

test('all modes respect constraints across 1,000 recommendations', () => {
  let total = 0;
  for (const mode of ['blended', 'all', 'recent', 'uniform']) {
    const rng = seeded();
    for (let i = 0; i < 25; i++) {
      const options = { count: 10, mode, include: [13], exclude: [1, 2, 45], balanced: true, avoidRun: true, avoidHistory: true };
      const games = C.generate(stats, options, rng);
      assert.equal(new Set(games.map(g => g.numbers.join(','))).size, 10);
      for (const game of games) {
        assert.equal(new Set(game.numbers).size, 6);
        assert.ok(game.numbers.includes(13));
        assert.ok(game.numbers.every(n => n >= 1 && n <= 45 && ![1, 2, 45].includes(n)));
        assert.ok(C.meetsFilters(game.numbers, options, stats));
        assert.ok(game.shape.odd >= 2 && game.shape.odd <= 4);
        assert.ok(game.shape.low >= 2 && game.shape.low <= 4);
        assert.ok(game.shape.longest < 3);
        total++;
      }
    }
  }
  assert.equal(total, 1000);
});

test('impossible pinned filters fail instead of silently changing the request', () => {
  assert.throws(() => C.generate(stats, { count: 1, include: [1, 2, 3, 4, 5, 6] }), /条件|조건/);
  const games = C.generate(stats, { count: 1, include: [1, 2, 3, 4, 5, 6], balanced: false, avoidRun: false }, seeded());
  assert.deepEqual(games[0].numbers, [1, 2, 3, 4, 5, 6]);
  assert.throws(() => C.generate(stats, { include: [1], exclude: [1] }), /동시에/);
  assert.throws(() => C.generate(stats, { count: 5, include: [1, 2, 3, 4, 5, 6] }), /1게임/);
  assert.throws(() => C.generate(stats, { exclude: Array.from({ length: 40 }, (_, i) => i + 1) }), /6개/);
});

test('uniform selection gives identical weights; hot-number mode reflects actual history', () => {
  assert.equal(new Set(C.weights(stats, 'uniform')).size, 1);
  const all = C.weights(stats, 'all');
  const hot = [...stats.rows].sort((a, b) => b.count - a.count)[0];
  const cold = [...stats.rows].sort((a, b) => a.count - b.count)[0];
  assert.ok(all[hot.number - 1] > all[cold.number - 1]);
  const changedGap = structuredClone({ ...stats, historical: undefined });
  changedGap.rows.forEach(r => { r.gap += 100; });
  assert.deepEqual(C.weights(changedGap, 'blended'), C.weights(stats, 'blended'));
});

test('actual draw comparison handles every prize rank and bonus correctly', () => {
  const draw = { numbers: [1, 2, 3, 4, 5, 6], bonus: 7 };
  assert.equal(C.check([1, 2, 3, 4, 5, 6], draw).rank, 1);
  assert.equal(C.check([1, 2, 3, 4, 5, 7], draw).rank, 2);
  assert.equal(C.check([1, 2, 3, 4, 5, 8], draw).rank, 3);
  assert.equal(C.check([1, 2, 3, 4, 7, 8], draw).rank, 4);
  assert.equal(C.check([1, 2, 3, 7, 8, 9], draw).rank, 5);
  assert.equal(C.check([1, 2, 7, 8, 9, 10], draw).rank, null);
  assert.throws(() => C.check([1, 1, 3, 4, 5, 6], draw));
});

test('new-draw freshness uses Saturday Korea time and a publication buffer', () => {
  assert.equal(C.expectedLatest(Date.parse('2026-10-10T08:04:00Z')), 1244);
  assert.equal(C.expectedLatest(Date.parse('2026-10-10T12:59:59Z')), 1244);
  assert.equal(C.expectedLatest(Date.parse('2026-10-10T13:00:00Z')), 1245);
});
