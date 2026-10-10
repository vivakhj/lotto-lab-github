(function (root, factory) {
  'use strict';
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.LottoCore = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';
  const NUMBERS = Array.from({ length: 45 }, (_, i) => i + 1);
  const FIRST_DATE = Date.UTC(2002, 11, 7);
  const DAY = 86400000;

  function validatePayload(payload) {
    if (!payload || !Array.isArray(payload.draws) || !payload.draws.length) throw new Error('당첨번호 데이터가 없습니다.');
    payload.draws.forEach((draw, i) => {
      if (draw.round !== i + 1) throw new Error(`${i + 1}회 데이터가 누락되었거나 중복되었습니다.`);
      if (!Array.isArray(draw.numbers) || draw.numbers.length !== 6 || new Set(draw.numbers).size !== 6 ||
          draw.numbers.some(n => !Number.isInteger(n) || n < 1 || n > 45) ||
          draw.numbers.some((n, j) => j > 0 && n <= draw.numbers[j - 1])) throw new Error(`${draw.round}회 당첨번호를 확인해주세요.`);
      if (!Number.isInteger(draw.bonus) || draw.bonus < 1 || draw.bonus > 45 || draw.numbers.includes(draw.bonus)) throw new Error(`${draw.round}회 보너스 번호를 확인해주세요.`);
      const expected = new Date(FIRST_DATE + i * 7 * DAY).toISOString().slice(0, 10);
      if (draw.date !== expected) throw new Error(`${draw.round}회 추첨일이 맞지 않습니다.`);
    });
    const meta = payload.metadata;
    if (!meta || meta.firstRound !== 1 || meta.lastRound !== payload.draws.length || meta.totalDraws !== payload.draws.length || meta.complete !== true) throw new Error('데이터 범위 정보를 확인해주세요.');
    return true;
  }

  function quantile(sorted, q) {
    const at = (sorted.length - 1) * q;
    const low = Math.floor(at), high = Math.ceil(at);
    return sorted[low] + (sorted[high] - sorted[low]) * (at - low);
  }

  function shape(numbers) {
    const ordered = [...numbers].sort((a, b) => a - b);
    let longest = 1, run = 1;
    ordered.forEach((n, i) => {
      if (!i) return;
      run = n === ordered[i - 1] + 1 ? run + 1 : 1;
      longest = Math.max(longest, run);
    });
    return { sum: ordered.reduce((a, b) => a + b, 0), odd: ordered.filter(n => n % 2).length,
      low: ordered.filter(n => n <= 22).length, longest };
  }

  function analyze(payload, windowSize = 52) {
    validatePayload(payload);
    if (!Number.isInteger(windowSize) || windowSize < 1) throw new Error('최근 분석 회차 수를 확인해주세요.');
    const draws = payload.draws;
    const recent = draws.slice(-windowSize);
    const allCounts = Array(46).fill(0), recentCounts = Array(46).fill(0), lastSeen = Array(46).fill(0);
    const oddHistogram = Array(7).fill(0), lowHistogram = Array(7).fill(0);
    const sums = [], pairs = new Map();
    let hasAdjacent = 0, threeConsecutive = 0;
    draws.forEach(draw => {
      draw.numbers.forEach(n => { allCounts[n]++; lastSeen[n] = draw.round; });
      const s = shape(draw.numbers);
      sums.push(s.sum); oddHistogram[s.odd]++; lowHistogram[s.low]++;
      if (s.longest >= 2) hasAdjacent++;
      if (s.longest >= 3) threeConsecutive++;
      draw.numbers.forEach((a, i) => draw.numbers.slice(i + 1).forEach(b => {
        const key = `${a},${b}`;
        pairs.set(key, (pairs.get(key) || 0) + 1);
      }));
    });
    recent.forEach(draw => draw.numbers.forEach(n => recentCounts[n]++));
    sums.sort((a, b) => a - b);
    const rows = NUMBERS.map(n => ({ number: n, count: allCounts[n], recent: recentCounts[n],
      gap: draws.length - lastSeen[n], lastSeen: lastSeen[n], rate: allCounts[n] / draws.length }));
    const pairRows = [...pairs.entries()].map(([key, count]) => ({ numbers: key.split(',').map(Number), count }))
      .sort((a, b) => b.count - a.count || a.numbers[0] - b.numbers[0] || a.numbers[1] - b.numbers[1]);
    return { rows, allCounts, recentCounts, total: draws.length, recentTotal: recent.length,
      recentFirst: recent[0].round, latest: draws[draws.length - 1],
      sumRange: [Math.ceil(quantile(sums, 0.1)), Math.floor(quantile(sums, 0.9))],
      meanSum: sums.reduce((a, b) => a + b, 0) / sums.length,
      oddHistogram, lowHistogram, hasAdjacent, threeConsecutive, pairRows,
      historical: new Set(draws.map(d => d.numbers.join(','))) };
  }

  // Numbers with higher empirical frequency are only slightly more likely to be
  // selected by this tool. This is a preference weight, never a win probability.
  function weights(stats, mode = 'blended') {
    if (!['blended', 'all', 'recent', 'uniform'].includes(mode)) throw new Error('추천 방식을 확인해주세요.');
    return NUMBERS.map(n => {
      if (mode === 'uniform') return 1;
      const overall = (stats.allCounts[n] + 1) / (stats.total * 6 + 45);
      const recent = (stats.recentCounts[n] + 1) / (stats.recentTotal * 6 + 45);
      const preference = mode === 'all' ? overall : mode === 'recent' ? recent : 0.7 * overall + 0.3 * recent;
      return Math.sqrt(preference * 45);
    });
  }

  function randomUnit() {
    if (!globalThis.crypto || typeof globalThis.crypto.getRandomValues !== 'function') throw new Error('이 브라우저는 안전한 난수 생성을 지원하지 않습니다. 최신 브라우저로 열어주세요.');
    const buffer = new Uint32Array(1);
    globalThis.crypto.getRandomValues(buffer);
    return buffer[0] / 4294967296;
  }

  function normalizeOptions(options) {
    const o = { count: 5, mode: 'blended', include: [], exclude: [], balanced: true, avoidRun: true, avoidHistory: false, ...options };
    if (!Number.isInteger(o.count) || o.count < 1 || o.count > 10) throw new Error('추천 개수는 1~10게임으로 선택해주세요.');
    for (const [label, arr] of [['고정', o.include], ['제외', o.exclude]]) {
      if (!Array.isArray(arr) || new Set(arr).size !== arr.length || arr.some(n => !Number.isInteger(n) || n < 1 || n > 45)) throw new Error(`${label} 번호는 중복 없이 1~45로 선택해주세요.`);
    }
    if (o.include.length > 6) throw new Error('고정 번호는 최대 6개입니다.');
    if (o.include.some(n => o.exclude.includes(n))) throw new Error('같은 번호를 고정과 제외에 동시에 넣을 수 없습니다.');
    if (45 - o.exclude.length < 6) throw new Error('제외 후 선택 가능한 번호가 6개보다 적습니다.');
    if (o.include.length === 6 && o.count !== 1) throw new Error('6개를 모두 고정하면 1게임만 생성할 수 있습니다.');
    return o;
  }

  function meetsFilters(numbers, o, stats) {
    const s = shape(numbers);
    if (o.avoidRun && s.longest >= 3) return false;
    if (o.balanced && (s.odd < 2 || s.odd > 4 || s.low < 2 || s.low > 4 || s.sum < stats.sumRange[0] || s.sum > stats.sumRange[1])) return false;
    if (o.avoidHistory && stats.historical.has(numbers.join(','))) return false;
    return true;
  }

  function generate(stats, options = {}, rng = randomUnit) {
    const o = normalizeOptions(options);
    const w = weights(stats, o.mode);
    const available = NUMBERS.filter(n => !o.exclude.includes(n) && !o.include.includes(n));
    const keys = new Set(), games = [];
    for (let attempts = 0; attempts < 16000 && games.length < o.count; attempts++) {
      const picked = [...o.include], pool = [...available];
      while (picked.length < 6) {
        const total = pool.reduce((acc, n) => acc + w[n - 1], 0);
        const unit = rng();
        if (!Number.isFinite(unit) || unit < 0 || unit >= 1) throw new Error('난수 생성 값을 확인해주세요.');
        let cursor = unit * total, at = pool.length - 1;
        for (let i = 0; i < pool.length; i++) {
          cursor -= w[pool[i] - 1];
          if (cursor < 0) { at = i; break; }
        }
        picked.push(pool.splice(at, 1)[0]);
      }
      picked.sort((a, b) => a - b);
      const key = picked.join(',');
      if (keys.has(key) || !meetsFilters(picked, o, stats)) {
        if (o.include.length === 6) break;
        continue;
      }
      keys.add(key);
      const details = picked.map(n => stats.rows[n - 1]);
      games.push({ numbers: picked, shape: shape(picked), details,
        historical: stats.historical.has(key), mode: o.mode });
    }
    if (games.length !== o.count) throw new Error('현재 조건으로 요청한 게임 수를 만들지 못했습니다. 고정·제외 번호를 줄이거나 형태 필터를 꺼주세요. 조건은 자동으로 바뀌지 않습니다.');
    return games;
  }

  function check(numbers, draw) {
    if (!Array.isArray(numbers) || numbers.length !== 6 || new Set(numbers).size !== 6 || numbers.some(n => !Number.isInteger(n) || n < 1 || n > 45)) throw new Error('중복 없이 1~45 번호 6개를 입력해주세요.');
    const matched = numbers.filter(n => draw.numbers.includes(n));
    const bonus = numbers.includes(draw.bonus);
    const rank = matched.length === 6 ? 1 : matched.length === 5 ? (bonus ? 2 : 3) : matched.length === 4 ? 4 : matched.length === 3 ? 5 : null;
    return { matched, bonus, rank };
  }

  function expectedLatest(now = Date.now()) {
    // Data publication may lag the Saturday 20:35 KST draw. Flag possible delay
    // after 22:00 KST, not as a claim that the data has already been published.
    const firstPublishUtc = FIRST_DATE + 13 * 3600000;
    return Math.max(0, Math.floor((now - firstPublishUtc) / (7 * DAY)) + 1);
  }

  return { NUMBERS, validatePayload, analyze, weights, shape, generate, meetsFilters, normalizeOptions, check, expectedLatest };
});
