(function () {
  'use strict';
  const C = window.LottoCore;
  const $ = id => document.getElementById(id);
  const esc = value => String(value).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const fmt = n => n.toLocaleString('ko-KR');
  const modeNames = { blended: '통계 혼합', all: '전체 기록 중심', recent: '최근 기록 중심', uniform: '균등 무작위' };
  const SAVE_KEY = 'lotto-lab-saved-v1', SETTINGS_KEY = 'lotto-lab-settings-v1';
  let payload, stats, games = [], generation = null, selectionMode = 'include';
  let include = [], exclude = [], saved = [], storageAvailable = true, toastTimer;

  function readLocal(key, fallback) {
    try { return JSON.parse(localStorage.getItem(key)) ?? fallback; }
    catch { storageAvailable = false; return fallback; }
  }

  function writeLocal(key, value) {
    try { localStorage.setItem(key, JSON.stringify(value)); return true; }
    catch { storageAvailable = false; toast('이 브라우저에 저장할 수 없습니다. 번호를 복사해 보관해주세요.'); return false; }
  }

  function toast(message) {
    clearTimeout(toastTimer); $('toast').textContent = message; $('toast').hidden = false;
    toastTimer = setTimeout(() => { $('toast').hidden = true; }, 3100);
  }

  function ball(n, small = false, clickable = true) {
    const cls = `ball c${Math.ceil(n / 10)}${small ? ' small' : ''}`;
    return clickable ? `<button type="button" class="${cls}" data-number="${n}" aria-label="${n}번 통계 보기">${n}</button>` : `<span class="${cls}">${n}</span>`;
  }

  function safeSaved(value) {
    return Array.isArray(value) ? value.filter(g => g && typeof g.id === 'string' &&
      Number.isInteger(g.targetRound) && g.targetRound >= 1 && Number.isInteger(g.basisRound) &&
      g.targetRound === g.basisRound + 1 && typeof g.createdAt === 'string' &&
      Array.isArray(g.numbers) && g.numbers.length === 6 && new Set(g.numbers).size === 6 &&
      g.numbers.every(n => Number.isInteger(n) && n >= 1 && n <= 45)).slice(0, 100) : [];
  }

  function switchTab(name, focus = false) {
    if (!['recommend', 'statistics', 'saved', 'help'].includes(name)) name = 'recommend';
    document.querySelectorAll('[data-tab]').forEach(button => {
      const active = button.dataset.tab === name;
      button.setAttribute('aria-selected', String(active)); button.tabIndex = active ? 0 : -1;
      if (active && focus) button.focus();
    });
    ['recommend', 'statistics', 'saved', 'help'].forEach(t => { $('panel-' + t).hidden = t !== name; });
    try { history.replaceState(null, '', '#' + name); } catch { /* Local-file preview */ }
  }

  function dataState() {
    const latest = stats.latest, meta = payload.metadata;
    $('headerRange').textContent = `1–${fmt(latest.round)}회 전체 기록`;
    $('latestRound').textContent = `제 ${fmt(latest.round)}회`;
    $('latestDate').textContent = latest.date.replace(/-/g, '.');
    $('latestBalls').innerHTML = latest.numbers.map(n => ball(n)).join('') + `<span class="bonus-divider" aria-hidden="true">+</span><span class="bonus-wrap">${ball(latest.bonus)}</span>`;
    $('sourceStatus').textContent = `동행복권 · ${fmt(stats.total)}개 회차 · 누락 없음`;
    const alerts = [];
    if (meta.updateState === 'failed') alerts.push(`최근 자동 갱신에 실패했습니다. 검증된 ${latest.round}회까지의 기록으로 작동합니다.`);
    if (C.expectedLatest() > latest.round) alerts.push(`새 추첨 결과가 아직 반영되지 않았을 수 있습니다. 현재 데이터는 ${latest.round}회 (${latest.date})까지입니다.`);
    if (!storageAvailable) alerts.push('현재 브라우저에서 저장 기능이 제한될 수 있습니다. 번호 복사를 이용해주세요.');
    $('dataAlert').textContent = alerts.join(' '); $('dataAlert').hidden = !alerts.length;
    $('dataAbout').textContent = `동행복권의 ${latest.date} 추첨까지 1~${latest.round}회 전체 기록을 사용합니다. 마지막 데이터 확인: ${new Date(meta.checkedAt).toLocaleString('ko-KR', { timeZone: 'Asia/Seoul' })}.`;
    $('checkRound').max = latest.round; $('checkRound').value = latest.round;
    if (location.hostname.endsWith('.chatgpt.site')) {
      $('dataAbout').textContent += ' 이 미리보기는 현재 확보한 데이터를 사용하며, 정기 갱신은 GitHub 배포 버전에서 동작합니다.';
    }
  }

  function renderSelection() {
    $('numberGrid').innerHTML = C.NUMBERS.map(n => {
      const state = include.includes(n) ? 'included' : exclude.includes(n) ? 'excluded' : '';
      const label = state === 'included' ? '고정됨' : state === 'excluded' ? '제외됨' : '선택 안 됨';
      return `<button class="pick-number ${state}" type="button" data-pick="${n}" aria-pressed="${Boolean(state)}" aria-label="${n}번 ${label}">${n}</button>`;
    }).join('');
    $('selectionSummary').textContent = `고정 ${include.length ? include.join('·') : '없음'} · 제외 ${exclude.length ? exclude.join('·') : '없음'}`;
    $('pickInclude').classList.toggle('selected', selectionMode === 'include');
    $('pickExclude').classList.toggle('selected', selectionMode === 'exclude');
    $('pickInclude').setAttribute('aria-pressed', String(selectionMode === 'include'));
    $('pickExclude').setAttribute('aria-pressed', String(selectionMode === 'exclude'));
  }

  function preferences() {
    return { mode: new FormData($('recommendForm')).get('mode'), windowSize: Number($('windowSize').value),
      count: Number($('gameCount').value), include, exclude,
      balanced: $('balanced').checked, avoidRun: $('avoidRun').checked, avoidHistory: $('avoidHistory').checked };
  }

  function rememberSettings() { writeLocal(SETTINGS_KEY, preferences()); }

  function restoreSettings() {
    const p = readLocal(SETTINGS_KEY, null);
    if (!p || typeof p !== 'object') return;
    if (modeNames[p.mode]) document.querySelector(`input[name="mode"][value="${p.mode}"]`).checked = true;
    if ([10, 26, 52, 104].includes(p.windowSize)) $('windowSize').value = p.windowSize;
    if ([1, 3, 5, 10].includes(p.count)) $('gameCount').value = p.count;
    ['balanced', 'avoidRun', 'avoidHistory'].forEach(k => { if (typeof p[k] === 'boolean') $(k).checked = p[k]; });
    try { C.normalizeOptions({ ...p, count: 1 }); include = p.include || []; exclude = p.exclude || []; } catch { include = []; exclude = []; }
  }

  function gameKey(numbers, round) { return `${round}:${numbers.join(',')}`; }
  function isSaved(numbers, round) { return saved.some(g => gameKey(g.numbers, g.targetRound) === gameKey(numbers, round)); }

  function renderGames() {
    if (!generation) return;
    $('games').innerHTML = games.map((game, i) => {
      const already = isSaved(game.numbers, generation.targetRound), s = game.shape;
      const labels = [`홀짝 ${s.odd}:${6 - s.odd}`, `고저 ${s.low}:${6 - s.low}`, `합계 ${s.sum}`];
      if (s.longest >= 2) labels.push(`최대 ${s.longest}개 연속`);
      return `<article class="game-card"><div class="game-top"><div class="game-label"><strong>${String.fromCharCode(65 + i)}</strong><span>${generation.targetRound}회용</span></div><div class="game-actions"><button type="button" class="action-button${already ? ' active' : ''}" data-save="${i}">${already ? '✓ 저장됨' : '저장'}</button><button type="button" class="action-button" data-copy="${i}">복사</button></div></div><div class="ball-row">${game.numbers.map(n => ball(n)).join('')}</div><div class="shape-tags">${labels.map(label => `<span>${label}</span>`).join('')}</div><details class="reason"><summary>추천 근거</summary><div class="reason-content"><p>${esc(modeNames[generation.options.mode])} · 1~${generation.basisRound}회 / 최근 ${generation.windowSize}회 기록. 번호 선택 가중치이며 당첨 확률 점수가 아닙니다.</p><table><thead><tr><th>번호</th><th>전체 출현</th><th>최근 출현</th><th>미출현</th></tr></thead><tbody>${game.details.map(d => `<tr><td>${d.number}</td><td>${d.count}회</td><td>${d.recent}회</td><td>${d.gap}회차</td></tr>`).join('')}</tbody></table><p>미출현 회차는 가중치에 사용하지 않습니다. 고저 기준: 1~22 / 23~45. ${game.historical ? '과거 같은 당첨 조합이 있습니다.' : '과거 동일 당첨 조합은 없습니다.'}</p></div></details></article>`;
    }).join('');
    $('copyAll').hidden = false;
  }

  function renderStatistics() {
    const top = [...stats.rows].sort((a, b) => b.count - a.count || a.number - b.number)[0];
    const recentTop = [...stats.rows].sort((a, b) => b.recent - a.recent || a.number - b.number)[0];
    const gapTop = [...stats.rows].sort((a, b) => b.gap - a.gap || a.number - b.number)[0];
    $('statisticsRange').textContent = `1~${stats.total}회 (${payload.draws[0].date} ~ ${stats.latest.date}) · 최근 구간 ${stats.recentFirst}~${stats.latest.round}회 · 보너스 제외`;
    $('statHighlights').innerHTML = [
      ['전체 최다 출현', top.number, `${top.count}회 / ${stats.total}회`, '동률일 때 작은 번호 표시'],
      [`최근 ${stats.recentTotal}회 최다`, recentTop.number, `${recentTop.recent}회 출현`, '동률일 때 작은 번호 표시'],
      ['가장 긴 미출현', gapTop.number, `${gapTop.gap}회차`, '다음 출현 가능성과 무관']
    ].map(([label, n, value, note]) => `<div class="stat-highlight"><span>${label}</span><strong>${ball(n, true)}${value.split(' / ')[0]}</strong><p>${note}</p></div>`).join('');
    renderHeat(); renderTable();
    const percent = n => `${(n / stats.total * 100).toFixed(1)}%`;
    const oddBalanced = stats.oddHistogram[2] + stats.oddHistogram[3] + stats.oddHistogram[4];
    $('shapeStats').innerHTML = [
      ['홀짝 3:3', `${percent(stats.oddHistogram[3])} (${stats.oddHistogram[3]}회)`],
      ['홀수 2~4개', `${percent(oddBalanced)} (${oddBalanced}회)`],
      ['연속번호 한 쌍 이상', `${percent(stats.hasAdjacent)} (${stats.hasAdjacent}회)`],
      ['3개 이상 연속번호', `${percent(stats.threeConsecutive)} (${stats.threeConsecutive}회)`],
      ['평균 번호 합계', stats.meanSum.toFixed(1)],
      ['역대 합계 10~90백분위', `${stats.sumRange[0]}~${stats.sumRange[1]}`]
    ].map(([label, value]) => `<div class="shape-stat"><span>${label}</span><strong>${value}</strong></div>`).join('');
    $('pairStats').innerHTML = stats.pairRows.slice(0, 5).map((p, i) => `<div class="pair-row"><span class="pair-index">0${i + 1}</span>${p.numbers.map(n => ball(n, true)).join('')}<strong>${p.count}회 함께 출현</strong></div>`).join('');
  }

  function renderHeat() {
    const metric = $('heatMetric').value, max = Math.max(...stats.rows.map(r => r[metric]));
    const min = Math.min(...stats.rows.map(r => r[metric]));
    const labels = { count: `전체 ${stats.total}회 중 당첨번호로 등장한 횟수입니다.`, recent: `최근 ${stats.recentTotal}회 중 등장한 횟수입니다.`, gap: '마지막 출현 후 지나간 회차 수입니다. 직전 출현은 0회차입니다.' };
    $('heatExplanation').textContent = labels[metric];
    $('heatGrid').innerHTML = stats.rows.map(r => {
      const strength = max === min ? 0.5 : (r[metric] - min) / (max - min);
      const color = `hsl(78 35% ${96 - strength * 29}%)`;
      return `<button type="button" class="heat-cell" style="background:${color}" data-number="${r.number}" aria-label="${r.number}번 ${metric === 'gap' ? '미출현 ' : '출현 '}${r[metric]}회${metric === 'gap' ? '차' : ''}, 상세 기록 보기"><strong>${r.number}</strong><small>${r[metric]}</small></button>`;
    }).join('');
    $('rankingTitle').textContent = metric === 'gap' ? '미출현 회차 TOP 10' : `${metric === 'recent' ? '최근 ' : ''}자주 나온 번호 TOP 10`;
    const sorted = [...stats.rows].sort((a, b) => b[metric] - a[metric] || a.number - b.number);
    $('rankingBars').innerHTML = sorted.slice(0, 10).map(r => `<div class="ranking-row">${ball(r.number, true)}<div class="ranking-track"><div class="ranking-fill" style="width:${max ? r[metric] / max * 100 : 0}%"></div></div><span class="ranking-value">${r[metric]}${metric === 'gap' ? '회차' : '회'}</span></div>`).join('');
  }

  function renderTable() {
    const sort = $('tableSort').value;
    const rows = [...stats.rows].sort((a, b) => sort === 'number' ? a.number - b.number : b[sort] - a[sort] || a.number - b.number);
    $('recentTableHeading').textContent = `최근 ${stats.recentTotal}회`;
    $('statisticsTable').innerHTML = rows.map(r => `<tr><td>${ball(r.number, true)}</td><td>${r.count}회</td><td>${(r.rate * 100).toFixed(2)}%</td><td>${r.recent}회</td><td>${r.gap}회차</td><td>${r.lastSeen}회</td></tr>`).join('');
  }

  function renderSaved() {
    $('savedCount').textContent = saved.length;
    if (!saved.length) { $('savedGames').innerHTML = '<div class="saved-empty">아직 저장한 번호가 없습니다.<br>번호 추천에서 마음에 드는 조합을 저장해보세요.</div>'; return; }
    $('savedGames').innerHTML = saved.map(g => {
      const draw = payload.draws[g.targetRound - 1];
      const result = draw ? C.check(g.numbers, draw) : null;
      const message = result ? (result.rank ? `${result.rank}등 · 당첨번호 ${result.matched.length}개 일치${result.rank === 2 ? ' + 보너스' : ''}` : `당첨번호 ${result.matched.length}개 일치 · 미당첨`) : `${g.targetRound}회 추첨 결과 반영 대기`;
      return `<article class="game-card"><div class="game-top"><div class="game-label"><strong>${g.targetRound}회용</strong><span>${esc(modeNames[g.mode] || '저장 번호')}</span></div><div class="game-actions"><button type="button" class="action-button" data-saved-copy="${esc(g.id)}">복사</button><button type="button" class="action-button" data-remove="${esc(g.id)}" aria-label="${esc(g.numbers.join(', '))} 저장 번호 삭제">삭제</button></div></div><div class="ball-row">${g.numbers.map(n => ball(n)).join('')}</div><p class="small-text" style="margin-top:11px">${g.basisRound}회까지 분석 · ${esc(new Date(g.createdAt).toLocaleDateString('ko-KR'))} 저장</p><div class="saved-verdict${result?.rank ? ' win' : ''}">${message}</div></article>`;
    }).join('');
  }

  function numberDetail(n) {
    const r = stats.rows[n - 1];
    $('dialogTitle').textContent = `${n}번의 기록`;
    const last = payload.draws[r.lastSeen - 1];
    $('numberDetail').innerHTML = ball(n, false, false) + [
      [`전체 ${stats.total}회 중 출현`, `${r.count}회`],
      ['회차당 출현율', `${(r.rate * 100).toFixed(2)}%`],
      [`최근 ${stats.recentTotal}회 중 출현`, `${r.recent}회`],
      ['마지막 출현', `${r.lastSeen}회 (${last ? last.date : '기록 없음'})`],
      ['마지막 출현 후', `${r.gap}회차`]
    ].map(([label, value]) => `<div class="detail-row"><span>${label}</span><strong>${value}</strong></div>`).join('') + '<p class="small-text">공정한 다음 추첨에서 이 번호가 6개 당첨번호에 포함될 확률은 6/45 ≈ 13.33%로, 다른 번호와 같습니다. 보너스는 이 통계에서 제외합니다.</p>';
    $('numberDialog').showModal();
  }

  async function copy(text) {
    try {
      if (navigator.clipboard && window.isSecureContext) await navigator.clipboard.writeText(text);
      else {
        const area = document.createElement('textarea'); area.value = text; area.style.position = 'fixed'; area.style.opacity = '0';
        document.body.appendChild(area); area.select(); const ok = document.execCommand('copy'); area.remove();
        if (!ok) throw new Error('copy');
      }
      toast('번호를 복사했습니다.');
    } catch { toast('복사가 제한되어 있습니다. 표시된 번호를 직접 복사해주세요.'); }
  }

  function downloadCsv() {
    const rows = [['회차', '추첨일', '번호1', '번호2', '번호3', '번호4', '번호5', '번호6', '보너스'],
      ...payload.draws.map(d => [d.round, d.date, ...d.numbers, d.bonus])];
    const url = URL.createObjectURL(new Blob(['\uFEFF' + rows.map(r => r.join(',')).join('\r\n')], { type: 'text/csv;charset=utf-8' }));
    const anchor = document.createElement('a'); anchor.href = url; anchor.download = `lotto-1-${stats.latest.round}.csv`; anchor.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  function useData(next) {
    C.validatePayload(next);
    if (payload && next.metadata.lastRound < payload.metadata.lastRound) throw new Error('새 데이터의 회차가 이전보다 적어 적용하지 않았습니다.');
    payload = next; stats = C.analyze(payload, Number($('windowSize').value));
    dataState(); renderStatistics(); renderSaved();
  }

  $('recommendForm').addEventListener('submit', event => {
    event.preventDefault(); if (!stats) return;
    $('generationError').hidden = true;
    try {
      const options = preferences();
      const next = C.generate(stats, options);
      games = next;
      generation = { options, windowSize: stats.recentTotal, basisRound: stats.latest.round, targetRound: stats.latest.round + 1 };
      $('resultTitle').textContent = `마음에 드는 조합을 골라보세요.`;
      $('resultDescription').textContent = `${generation.targetRound}회용 ${games.length}게임 · ${modeNames[options.mode]} · 1~${generation.basisRound}회 기록 반영`;
      renderGames(); rememberSettings();
      if (matchMedia('(max-width: 760px)').matches) $('resultTitle').scrollIntoView({ behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth', block: 'start' });
    } catch (error) { $('generationError').textContent = error.message; $('generationError').hidden = false; }
  });

  document.addEventListener('click', event => {
    const target = event.target.closest('button'); if (!target) return;
    if (target.dataset.tab) switchTab(target.dataset.tab);
    if (target.dataset.number && stats) numberDetail(Number(target.dataset.number));
    if (target.dataset.pick) {
      const n = Number(target.dataset.pick), selected = selectionMode === 'include' ? include : exclude;
      if (selected.includes(n)) selected.splice(selected.indexOf(n), 1);
      else {
        if (selectionMode === 'include' && include.length >= 6) { toast('고정 번호는 최대 6개입니다.'); return; }
        if (selectionMode === 'exclude' && exclude.length >= 39) { toast('선택 가능한 번호가 6개 이상 남아야 합니다.'); return; }
        include = include.filter(v => v !== n); exclude = exclude.filter(v => v !== n);
        (selectionMode === 'include' ? include : exclude).push(n);
      }
      include.sort((a, b) => a - b); exclude.sort((a, b) => a - b); renderSelection(); rememberSettings();
    }
    if (target.dataset.save !== undefined) {
      const game = games[Number(target.dataset.save)]; if (!game || !generation) return;
      if (isSaved(game.numbers, generation.targetRound)) { toast('이미 저장한 번호입니다.'); return; }
      if (saved.length >= 100) { toast('최대 100게임까지 저장할 수 있습니다. 오래된 번호를 삭제해주세요.'); return; }
      const entry = { id: crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${saved.length}`, numbers: game.numbers,
        targetRound: generation.targetRound, basisRound: generation.basisRound, createdAt: new Date().toISOString(),
        mode: generation.options.mode, windowSize: generation.windowSize };
      const next = [entry, ...saved];
      if (writeLocal(SAVE_KEY, next)) { saved = next; renderSaved(); renderGames(); toast('내 번호에 저장했습니다.'); }
    }
    if (target.dataset.copy !== undefined) { const game = games[Number(target.dataset.copy)]; if (game) copy(`${generation.targetRound}회: ${game.numbers.join(', ')}`); }
    if (target.dataset.remove) {
      const next = saved.filter(g => g.id !== target.dataset.remove);
      if (writeLocal(SAVE_KEY, next)) { saved = next; renderSaved(); renderGames(); toast('저장 번호를 삭제했습니다.'); }
    }
    if (target.dataset.savedCopy) { const game = saved.find(g => g.id === target.dataset.savedCopy); if (game) copy(`${game.targetRound}회: ${game.numbers.join(', ')}`); }
  });

  document.querySelector('[role="tablist"]').addEventListener('keydown', event => {
    const keys = ['ArrowRight', 'ArrowLeft', 'Home', 'End']; if (!keys.includes(event.key)) return;
    const tabs = [...document.querySelectorAll('[data-tab]')], current = tabs.indexOf(document.activeElement);
    const index = event.key === 'Home' ? 0 : event.key === 'End' ? tabs.length - 1 : (current + (event.key === 'ArrowRight' ? 1 : -1) + tabs.length) % tabs.length;
    event.preventDefault(); switchTab(tabs[index].dataset.tab, true);
  });
  $('pickInclude').onclick = () => { selectionMode = 'include'; renderSelection(); };
  $('pickExclude').onclick = () => { selectionMode = 'exclude'; renderSelection(); };
  $('resetNumbers').onclick = () => { include = []; exclude = []; renderSelection(); rememberSettings(); };
  $('windowSize').onchange = () => { if (payload) { stats = C.analyze(payload, Number($('windowSize').value)); renderStatistics(); } rememberSettings(); };
  $('recommendForm').addEventListener('change', rememberSettings);
  $('heatMetric').onchange = renderHeat; $('tableSort').onchange = renderTable;
  $('helpShortcut').onclick = () => switchTab('help', true);
  $('closeDialog').onclick = () => $('numberDialog').close();
  $('numberDialog').addEventListener('click', e => { if (e.target === $('numberDialog')) { const r = $('numberDialog').getBoundingClientRect(); if (e.clientX < r.left || e.clientX > r.right || e.clientY < r.top || e.clientY > r.bottom) $('numberDialog').close(); } });
  $('copyAll').onclick = () => copy(games.map((g, i) => `${generation.targetRound}회 ${String.fromCharCode(65 + i)}: ${g.numbers.join(', ')}`).join('\n'));
  $('copySaved').onclick = () => saved.length ? copy(saved.map(g => `${g.targetRound}회: ${g.numbers.join(', ')}`).join('\n')) : toast('저장한 번호가 없습니다.');
  $('exportData').onclick = downloadCsv;
  $('checkForm').onsubmit = event => {
    event.preventDefault();
    try {
      if (!payload) throw new Error('데이터를 먼저 확인해주세요.');
      const round = Number($('checkRound').value), draw = payload.draws[round - 1];
      if (!Number.isInteger(round) || !draw) throw new Error(`1~${stats.latest.round}회 중 선택해주세요.`);
      const raw = $('checkNumbers').value.trim();
      if (!/^\d+(?:[\s,，·]+\d+)*$/.test(raw)) throw new Error('번호는 쉼표 또는 공백으로 구분해주세요.');
      const numbers = raw.split(/[\s,，·]+/).map(Number), result = C.check(numbers, draw);
      $('checkResult').innerHTML = `<div class="check-result"><strong>${result.rank ? `${result.rank}등` : '미당첨'}</strong>${round}회 당첨번호 ${result.matched.length}개 일치${result.bonus ? ' · 보너스 포함' : ''}<p>당첨번호: ${draw.numbers.join(', ')} / 보너스 ${draw.bonus}</p><p class="small-text">${result.matched.length ? `일치 번호: ${result.matched.join(', ')}` : '일치한 당첨번호가 없습니다.'} · 최종 확인은 공식 결과를 이용하세요.</p></div>`;
    } catch (e) { $('checkResult').innerHTML = `<p class="error-message">${esc(e.message)}</p>`; }
  };
  $('refreshButton').onclick = async () => {
    if (location.protocol === 'file:') { toast('로컬 파일은 포함된 기록을 사용합니다. 배포된 주소에서 최신 데이터를 확인하세요.'); return; }
    const button = $('refreshButton'); button.disabled = true;
    try {
      const controller = new AbortController(), timer = setTimeout(() => controller.abort(), 12000);
      let response;
      try { response = await fetch('./data/lotto.json', { cache: 'no-store', signal: controller.signal }); }
      finally { clearTimeout(timer); }
      if (!response.ok) throw new Error('기록을 불러올 수 없습니다.');
      const next = await response.json(); useData(next);
      toast(`현재 배포된 데이터는 ${stats.latest.round}회까지입니다.`);
    } catch { toast('새 기록 확인에 실패했습니다. 기존 데이터를 유지합니다.'); }
    finally { button.disabled = false; }
  };

  restoreSettings(); saved = safeSaved(readLocal(SAVE_KEY, [])); renderSelection();
  try {
    useData(window.LOTTO_DATA);
    $('generateButton').disabled = false;
    switchTab(location.hash.slice(1));
    // Refresh our own packaged dataset. Never rely on cross-origin requests to
    // the official site or on an unofficial CORS proxy in the user's browser.
    if (location.protocol !== 'file:') {
      const ctl = new AbortController(), timeout = setTimeout(() => ctl.abort(), 8000);
      fetch('./data/lotto.json', { cache: 'no-store', signal: ctl.signal }).then(r => r.ok ? r.json() : null).then(next => {
        if (next && next.metadata.checkedAt !== payload.metadata.checkedAt) useData(next);
      }).catch(() => {}).finally(() => clearTimeout(timeout));
    }
  } catch (error) {
    $('generateButton').disabled = true; $('headerRange').textContent = '데이터 확인 필요';
    $('dataAlert').textContent = `당첨번호 데이터 검증에 실패했습니다. ${error.message} 데이터 파일을 복원해주세요.`; $('dataAlert').hidden = false;
  }
  if ('serviceWorker' in navigator && location.protocol === 'https:') navigator.serviceWorker.register('./sw.js').catch(() => {});
})();
