'use strict';

const COLORS = ['.', 'R', 'Y', 'G', 'B', 'P', '#'];
const COLOR_LABELS = { '.': '空', R: 'R', Y: 'Y', G: 'G', B: 'B', P: 'P', '#': '×' };
const PLAYERS = ['p1', 'p2'];

let selectedColor = 'R';
let selectedFile = null;
let previewUrl = null;
let state = {
  p1: emptyPlayer(),
  p2: emptyPlayer(),
};

let evalWorker = null;
let evalWorkerReady = false;
let evalWorkerReadyPromise = null;
let evalCallId = 0;
const evalPending = new Map();

function rejectPendingEvalCalls(error) {
  for (const [id, callbacks] of evalPending.entries()) {
    evalPending.delete(id);
    if (callbacks.timer) clearTimeout(callbacks.timer);
    callbacks.reject(error);
  }
}

function resetEvalWorker(error) {
  if (evalWorker) evalWorker.terminate();
  evalWorker = null;
  evalWorkerReady = false;
  evalWorkerReadyPromise = null;
  if (error) rejectPendingEvalCalls(error);
}

async function ensureCrossOriginIsolation() {
  if (self.crossOriginIsolated && typeof SharedArrayBuffer !== 'undefined') {
    sessionStorage.removeItem('amaAnalyzerIsolationReloads');
    return;
  }
  if (!('serviceWorker' in navigator)) {
    throw new Error('このブラウザではSharedArrayBufferに必要なService Workerが使えません');
  }

  const attempts = Number(sessionStorage.getItem('amaAnalyzerIsolationReloads') || 0);
  if (attempts >= 2) {
    throw new Error('SharedArrayBufferが有効になっていません。ページを強制再読み込みしてください。');
  }

  setStatus('ama初期化のためページを再読み込みします...');
  sessionStorage.setItem('amaAnalyzerIsolationReloads', String(attempts + 1));
  sessionStorage.removeItem('coiReloadedBySelf');

  try {
    const reg = await navigator.serviceWorker.register('coi-serviceworker.js');
    await reg.update();
  } finally {
    location.reload();
  }

  await new Promise(() => {});
}

function initEvalWorker() {
  if (evalWorkerReadyPromise) return evalWorkerReadyPromise;
  evalWorkerReadyPromise = (async () => {
    await ensureCrossOriginIsolation();
    return new Promise((resolve, reject) => {
      let settled = false;
      const fail = message => {
        if (settled) return;
        settled = true;
        resetEvalWorker();
        reject(new Error(message || 'WASM初期化に失敗しました'));
      };
      const initTimer = setTimeout(() => fail('ama初期化がタイムアウトしました。再読み込みしてください。'), 15000);
      evalWorker = new Worker('eval-worker.js');
      evalWorker.onmessage = e => {
        if (e.data.type === 'ready') {
          if (settled) return;
          settled = true;
          clearTimeout(initTimer);
          evalWorkerReady = true;
          resolve();
          return;
        }
        if (e.data.type === 'init_error') {
          clearTimeout(initTimer);
          fail(e.data.message || 'WASM初期化に失敗しました');
          return;
        }
        const callbacks = evalPending.get(e.data.id);
        if (!callbacks) return;
        evalPending.delete(e.data.id);
        if (callbacks.timer) clearTimeout(callbacks.timer);
        if (e.data.error) callbacks.reject(new Error(e.data.error));
        else {
          try {
            callbacks.resolve(JSON.parse(e.data.result));
          } catch (err) {
            callbacks.reject(err);
          }
        }
      };
      evalWorker.onerror = e => fail(e.message || 'WASM worker error');
    });
  })();
  return evalWorkerReadyPromise;
}

async function queryEvalWasm(payload, timeoutMs = 70000) {
  if (!evalWorkerReady) await initEvalWorker();
  return new Promise((resolve, reject) => {
    const id = evalCallId++;
    const timer = setTimeout(() => {
      evalPending.delete(id);
      resetEvalWorker();
      reject(new Error('ama評価がタイムアウトしました。幅/深さを下げるか、盤面・ツモを確認してください。'));
    }, timeoutMs);
    evalPending.set(id, { resolve, reject, timer });
    evalWorker.postMessage({ id, input: JSON.stringify(payload) });
  });
}

function activeColors(player) {
  const colors = [];
  function add(c) {
    if (['R', 'Y', 'G', 'B', 'P'].includes(c) && !colors.includes(c)) colors.push(c);
  }
  for (const row of player.field || []) {
    for (const c of String(row)) add(c);
  }
  const pairs = [];
  if (player.current_piece) pairs.push(player.current_piece);
  pairs.push(...(player.queue || []));
  for (const pair of pairs) {
    if (!Array.isArray(pair)) continue;
    add(pair[0]);
    add(pair[1]);
  }
  return colors;
}

function normalizePlayerForAma(player) {
  const amaColors = ['R', 'Y', 'G', 'B'];
  const colors = activeColors(player);
  if (colors.length > 4) throw new Error(`ama supports up to 4 colors: ${colors.join('')}`);
  const mapping = { '.': '.', '#': '#' };
  colors.forEach((c, i) => { mapping[c] = amaColors[i]; });

  const field = (player.field || []).map(row => String(row).slice(0, 6).padEnd(6, '.').split('').map(c => mapping[c] || '.').join(''));
  if (field.length !== 13) throw new Error('field must contain exactly 13 rows');

  const queue = [];
  const pairs = [];
  if (player.current_piece) pairs.push(player.current_piece);
  pairs.push(...(player.queue || []));
  for (const pair of pairs) {
    if (!Array.isArray(pair) || pair.length !== 2) continue;
    const a = mapping[pair[0]];
    const b = mapping[pair[1]];
    if (a && b && a !== '.' && b !== '.' && a !== '#' && b !== '#') queue.push([a, b]);
  }
  if (queue.length < 3) throw new Error('current piece plus NEXT1 and NEXT2 are required');
  return { field, queue, garbage: Math.max(0, Number(player.garbage) || 0) };
}

function actionSend(action) {
  const attack = action?.attack || {};
  return Number(attack.send_total ?? attack.send ?? 0) || 0;
}

function summarySend(summary) {
  if (!summary) return 0;
  return actionSend(summary.best);
}

function buildScore(side) {
  const build = side?.strategy?.build_quality || {};
  const beam = build.beam_build?.best?.ama_eval;
  if (beam !== undefined && beam !== null) return Number(beam) || 0;
  return Number(build.fast_build?.best?.value || 0);
}

function sideBattleMetrics(side) {
  const strategy = side?.strategy || {};
  const incoming = strategy.incoming || {};
  const offense = strategy.offense || {};
  const pending = side?.pending || {};
  const responseCandidates = [
    summarySend(incoming.all_clear_return),
    summarySend(incoming.immediate_main_return?.candidates),
    summarySend(incoming.syncro_return),
    summarySend(incoming.small_return),
    summarySend(incoming.main_return),
    summarySend(incoming.desperate_return),
    Number(offense.attack_max_send_total || 0),
  ];
  for (const action of side?.self_attack_candidates || []) responseCandidates.push(actionSend(action));
  const incomingCount = Number(pending.incoming || 0);
  const acceptLimit = Number(incoming.accept_limit ?? side?.defense?.accept_limit ?? 0);
  const responseSend = Math.max(0, ...responseCandidates.map(v => Number(v) || 0));
  const survivalMargin = acceptLimit + responseSend - incomingCount;
  let status = 'stable';
  if (incomingCount > 0 && survivalMargin < 0) status = 'critical';
  else if (incomingCount > acceptLimit) status = 'counter_required';
  else if (incomingCount > 0) status = 'can_accept';
  return {
    incoming: incomingCount,
    accept_limit: acceptLimit,
    max_response_send: responseSend,
    survival_margin: survivalMargin,
    attack_max_send: Number(offense.attack_max_send_total || 0),
    build_score: buildScore(side),
    status,
  };
}

function estimateBattle(strategy) {
  if (!strategy?.p1 || !strategy?.p2) return null;
  const metrics = { p1: sideBattleMetrics(strategy.p1), p2: sideBattleMetrics(strategy.p2) };
  const p1 = metrics.p1;
  const p2 = metrics.p2;
  const p1Dead = p1.status === 'critical';
  const p2Dead = p2.status === 'critical';
  const marginDiff = p1.survival_margin - p2.survival_margin;
  const attackDiff = p1.attack_max_send - p2.attack_max_send;
  const buildDiff = p1.build_score - p2.build_score;
  let leader;
  let score;
  let reason;
  if (p1Dead && !p2Dead) {
    leader = 'p2';
    score = -100000 + marginDiff * 100;
    reason = `P1は受け+最大返しが頭上おじゃまに${Math.abs(p1.survival_margin)}個不足`;
  } else if (p2Dead && !p1Dead) {
    leader = 'p1';
    score = 100000 + marginDiff * 100;
    reason = `P2は受け+最大返しが頭上おじゃまに${Math.abs(p2.survival_margin)}個不足`;
  } else if (p1Dead && p2Dead) {
    score = marginDiff * 100 + attackDiff * 10;
    leader = score > 0 ? 'p1' : score < 0 ? 'p2' : 'even';
    reason = '双方が致死級のおじゃまを抱えているため、生存余力の差を優先';
  } else {
    score = marginDiff * 100 + attackDiff * 10 + buildDiff / 100;
    leader = score > 250 ? 'p1' : score < -250 ? 'p2' : 'even';
    reason = `生存余力差 ${marginDiff}個、最大火力差 ${attackDiff}個、積み評価差 ${buildDiff}`;
  }
  const confidence = Math.abs(score) >= 5000 || p1Dead !== p2Dead ? 'high' : Math.abs(score) >= 1000 ? 'medium' : 'low';
  return { leader, score: Math.trunc(score), confidence, players: metrics, reason };
}

function beamCandidates(side) {
  const top = side?.strategy?.build_quality?.beam_build?.top || [];
  return {
    candidates: top.map(c => ({
      x: c.placement?.x ?? 0,
      r: c.placement?.r ?? 'UP',
      score: c.score ?? 0,
      expected_score: c.ama_eval ?? c.score ?? 0,
    })),
    elapsed_ms: side?.elapsed_ms,
  };
}

function prepareEvalResponse(raw) {
  if (raw.error) return raw;
  const strategy = { p1: raw.p1, p2: raw.p2 };
  const battleEval = estimateBattle(strategy);
  if (battleEval) {
    if (strategy.p1) strategy.p1.battle = battleEval.players.p1;
    if (strategy.p2) strategy.p2.battle = battleEval.players.p2;
  }
  return {
    players: { p1: beamCandidates(raw.p1), p2: beamCandidates(raw.p2) },
    strategy,
    battle_eval: battleEval,
    eval: null,
    meta: raw.meta,
  };
}

function emptyPlayer() {
  return {
    field: Array.from({ length: 13 }, () => '......'),
    current_piece: ['R', 'R'],
    current_piece_detected: true,
    queue: [['R', 'R'], ['R', 'R']],
    garbage: 0,
  };
}

function setStatus(message, isError = false) {
  const el = document.getElementById('status');
  el.textContent = message || '';
  el.classList.toggle('error', isError);
}

function cellClass(color) {
  if (color === '.') return 'color-empty';
  if (color === '#') return 'color-garbage';
  return `color-${color}`;
}

function normalizeOptionalPair(pair) {
  if (!Array.isArray(pair) || pair.length !== 2) return null;
  const a = COLORS.includes(pair[0]) && pair[0] !== '.' && pair[0] !== '#' ? pair[0] : null;
  const b = COLORS.includes(pair[1]) && pair[1] !== '.' && pair[1] !== '#' ? pair[1] : null;
  return a && b ? [a, b] : null;
}

function normalizePair(pair) {
  return normalizeOptionalPair(pair) || ['R', 'R'];
}

function normalizePlayer(player) {
  const next = emptyPlayer();
  if (Array.isArray(player.field) && player.field.length === 13) {
    next.field = player.field.map(row => {
      const chars = String(row).slice(0, 6).padEnd(6, '.').split('');
      return chars.map(c => COLORS.includes(c) ? c : '.').join('');
    });
  }
  const queue = Array.isArray(player.queue) ? player.queue : [];
  const q0 = normalizeOptionalPair(queue[0]);
  const q1 = normalizeOptionalPair(queue[1]);
  next.queue = [q0 || ['R', 'R'], q1 || q0 || ['R', 'R']];
  const current = normalizeOptionalPair(player.current_piece);
  if (current) {
    next.current_piece = current;
    next.current_piece_detected = true;
  } else {
    next.current_piece = next.queue[0];
    next.current_piece_detected = false;
  }
  next.garbage = Math.max(0, Number(player.garbage) || 0);
  return next;
}

function buildPalette() {
  const palette = document.getElementById('palette');
  palette.innerHTML = '';
  for (const color of COLORS) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = `${cellClass(color)} ${color === selectedColor ? 'active' : ''}`;
    btn.textContent = COLOR_LABELS[color];
    btn.title = color === '.' ? '空セル' : color === '#' ? 'おじゃまぷよ' : `${color}ぷよ`;
    btn.addEventListener('click', () => {
      selectedColor = color;
      buildPalette();
    });
    palette.appendChild(btn);
  }
}

function pairSelect(playerKey, role, index, value) {
  const select = document.createElement('select');
  for (const color of COLORS.filter(c => c !== '.' && c !== '#')) {
    const option = document.createElement('option');
    option.value = color;
    option.textContent = color;
    select.appendChild(option);
  }
  select.value = value;
  select.addEventListener('change', () => {
    if (role === 'current') {
      state[playerKey].current_piece[index] = select.value;
      state[playerKey].current_piece_detected = true;
    } else {
      const queueIndex = role === 'next0' ? 0 : 1;
      state[playerKey].queue[queueIndex][index] = select.value;
    }
  });
  return select;
}

function renderPairEditors(playerKey) {
  const playerEl = document.querySelector(`.player[data-player="${playerKey}"]`);
  const roles = {
    current: state[playerKey].current_piece,
    next0: state[playerKey].queue[0],
    next1: state[playerKey].queue[1],
  };
  for (const [role, pair] of Object.entries(roles)) {
    const el = playerEl.querySelector(`.pair-editor[data-role="${role}"]`);
    el.innerHTML = '';
    el.appendChild(pairSelect(playerKey, role, 0, pair[0]));
    el.appendChild(pairSelect(playerKey, role, 1, pair[1]));
  }
  const garbage = playerEl.querySelector('.garbage-input');
  garbage.value = state[playerKey].garbage;
  garbage.oninput = () => {
    state[playerKey].garbage = Math.max(0, Number(garbage.value) || 0);
  };
}

function renderBoard(playerKey) {
  const board = document.querySelector(`.board[data-player="${playerKey}"]`);
  board.innerHTML = '';
  const field = state[playerKey].field;
  for (let row = 0; row < 13; row++) {
    for (let col = 0; col < 6; col++) {
      const color = field[row][col];
      const cell = document.createElement('button');
      cell.type = 'button';
      cell.className = `cell ${cellClass(color)} ${row === 0 ? 'hidden-row' : ''}`;
      cell.textContent = COLOR_LABELS[color];
      cell.title = `${playerKey.toUpperCase()} row ${row}, col ${col + 1}`;
      cell.addEventListener('click', () => {
        const chars = state[playerKey].field[row].split('');
        chars[col] = selectedColor;
        state[playerKey].field[row] = chars.join('');
        renderBoard(playerKey);
      });
      board.appendChild(cell);
    }
  }
}

function renderAll() {
  for (const playerKey of PLAYERS) {
    renderPairEditors(playerKey);
    renderBoard(playerKey);
  }
  document.getElementById('analyze-btn').disabled = false;
}

async function analyzeImage() {
  if (!selectedFile) return;
  if (typeof window.analyzeScreenFile !== 'function') {
    setStatus('画像解析モジュールが読み込まれていません', true);
    return;
  }
  const analyzeBtn = document.getElementById('analyze-btn');
  analyzeBtn.disabled = true;
  setStatus('画像読み取り中...');
  const data = await window.analyzeScreenFile(selectedFile);
  if (data.error) {
    setStatus(data.error || '画像読み取りに失敗しました', true);
    analyzeBtn.disabled = false;
    return;
  }
  state.p1 = normalizePlayer(data.p1 || {});
  state.p2 = normalizePlayer(data.p2 || {});
  renderAll();
  renderMessages(JSON.stringify(data, null, 2));
  const missingCurrent = PLAYERS.filter(playerKey => !state[playerKey].current_piece_detected).map(playerKey => playerKey.toUpperCase());
  analyzeBtn.disabled = false;
  if (missingCurrent.length) {
    setStatus(`画像読み取り完了。現在ツモ未検出: ${missingCurrent.join('/')} は仮入力です。目視で修正してから解析してください。`);
  } else {
    setStatus('画像読み取り完了。必要なら目視で盤面・ツモ・頭上おじゃまを修正してから解析してください。');
  }
}

function renderCandidates(id, result) {
  const list = document.getElementById(id);
  list.innerHTML = '';
  if (!result || result.error) {
    const li = document.createElement('li');
    li.textContent = result?.error || '候補なし';
    list.appendChild(li);
    return;
  }
  const candidates = result.candidates || [];
  for (const c of candidates.slice(0, 5)) {
    const li = document.createElement('li');
    li.textContent = `x=${c.x + 1} ${c.r} score=${Number(c.expected_score).toLocaleString()}`;
    list.appendChild(li);
  }
}

function formatNumber(value) {
  if (value === null || value === undefined || Number.isNaN(Number(value))) return '-';
  return Number(value).toLocaleString();
}

function placementText(placement) {
  if (!placement) return '-';
  const x = Number(placement.x);
  const col = Number.isFinite(x) ? x + 1 : '-';
  return `x=${col} ${placement.r || ''}`.trim();
}

function actionArraySummary(actions) {
  if (!Array.isArray(actions) || actions.length === 0) return '0件';
  const first = actions[0] || {};
  const attack = first.attack || {};
  return `${actions.length}件 / ${placementText(first.placement)} ${formatNumber(attack.send_total)}個 ${formatNumber(attack.chain_count)}連鎖`;
}

function buildSummary(section) {
  const count = Number(section?.count || 0);
  if (!section?.best) return `${count}件`;
  const best = section.best;
  if (best.ama_eval !== undefined) {
    return `${count}件 / ${placementText(best.placement)} eval ${formatNumber(best.ama_eval)}`;
  }
  return `${count}件 / ${placementText(best.placement)} value ${formatNumber(best.value)} q ${formatNumber(best.q)}`;
}

function compactBuildSummary(section) {
  const count = Number(section?.count || 0);
  if (!section?.best) return `${count}件`;
  const best = section.best;
  const score = best.ama_eval !== undefined ? best.ama_eval : best.value;
  return `${count}件 / ${placementText(best.placement)} ${formatNumber(score)}`;
}

function summarizeBestAttack(summary) {
  const data = summary?.candidates || summary;
  const count = Number(data?.count || 0);
  if (!data?.best) return `${count}件`;
  const attack = data.best.attack || {};
  return `${count}件 / ${formatNumber(attack.send_total)}個 / ${placementText(data.best.placement)}`;
}

function buildModeText(type) {
  const labels = {
    BUILD: 'BUILD 長期の形重視',
    FREESTYLE: 'FREESTYLE 自由度重視',
    FAST: 'FAST 短期・速度重視',
    AC: 'AC 全消し/受け重視',
  };
  return labels[type] || type || '-';
}

function yesNo(value) {
  return value ? 'yes' : 'no';
}

function hasAmaMove(summary) {
  return Boolean(summary?.contains_ama_move || summary?.candidates?.contains_ama_move);
}

function inferDecision(side) {
  const strategy = side?.strategy || {};
  const incoming = strategy.incoming || {};
  const offense = strategy.offense || {};

  if (incoming.active) {
    if (hasAmaMove(incoming.all_clear_return)) return '全消し返し';
    if (hasAmaMove(incoming.immediate_main_return)) return '即主砲で相殺';
    if (hasAmaMove(incoming.syncro_return)) return 'クロス/同期返し';
    if (hasAmaMove(incoming.small_return)) return '小連鎖で返す';
    if (hasAmaMove(incoming.main_return)) return '主砲返し';
    if (hasAmaMove(incoming.desperate_return)) return '最大火力で粘る';
    if (incoming.can_accept) return '受けて積む';
    return '防御判断';
  }

  if (hasAmaMove(offense.counter_attack_during_enemy_chain)) return '敵発火への速攻';
  if (hasAmaMove(offense.kill?.candidates)) return 'キル狙い';
  if (hasAmaMove(offense.harass?.crush)) return '潰し';
  if (hasAmaMove(offense.harass?.combo)) return '二段催促';
  return '積む';
}

function decisionExplanation(side, decision) {
  const strategy = side?.strategy || {};
  const incoming = strategy.incoming || {};
  const offense = strategy.offense || {};
  const pending = side?.pending || {};
  const battle = side?.battle || {};
  const enemyRead = side?.enemy_read || {};
  const incomingCount = Number(pending.incoming || 0);
  const acceptLimit = Number(incoming.accept_limit ?? side?.defense?.accept_limit ?? 0);
  const margin = Number(battle.survival_margin || 0);
  const maxResponse = Number(battle.max_response_send || 0);
  const attackMax = Number(offense.attack_max_send_total || 0);

  switch (decision) {
  case '全消し返し':
    return `相手の序盤全消し連鎖に対して、間に合う全消し返し候補があります。最良候補は${summarizeBestAttack(incoming.all_clear_return)}です。`;
  case '即主砲で相殺':
    return `頭上${formatNumber(incomingCount)}個に対し、即主砲候補が相殺条件を満たしています。最良候補は${summarizeBestAttack(incoming.immediate_main_return?.candidates)}です。`;
  case 'クロス/同期返し':
    return `相手発火に速度を合わせられる返しがあります。量と着弾の速さを優先し、${summarizeBestAttack(incoming.syncro_return)}を選びます。`;
  case '受けて積む':
    return `頭上${formatNumber(incomingCount)}個は受け許容量${formatNumber(acceptLimit)}個の範囲内です。撃たずに${buildModeText(incoming.accept_build_type)}で積みます。`;
  case '小連鎖で返す':
    return `受けだけでは足りないため、盤面を残しやすい小返しを優先します。最良候補は${summarizeBestAttack(incoming.small_return)}です。`;
  case '主砲返し':
    return `小返しや受けでは不足するため、主砲返しを選びます。候補は${summarizeBestAttack(incoming.main_return)}です。`;
  case '最大火力で粘る':
    return `十分な返しはありませんが、即死を避けるため最大火力に近い返しを選びます。候補は${summarizeBestAttack(incoming.desperate_return)}です。`;
  case '敵発火への速攻':
    return `相手の連鎖中に間に合う速い攻撃があります。相手3列目の空きを見て、${summarizeBestAttack(offense.counter_attack_during_enemy_chain)}を合わせます。`;
  case 'キル狙い':
    return `相手盤面がおじゃまで埋まり気味です。必要${formatNumber(offense.kill?.attack_need)}個に対し、キル候補${summarizeBestAttack(offense.kill?.candidates)}があります。`;
  case '潰し':
    return `自分の最大火力は${formatNumber(attackMax)}個でまだ発火優先ではありません。相手防御を超える潰し候補${summarizeBestAttack(offense.harass?.crush)}を選びます。`;
  case '二段催促':
    return `小さな催促後に大きな追撃が残る二段候補があります。候補は${summarizeBestAttack(offense.harass?.combo)}です。`;
  case '防御判断':
    return `頭上${formatNumber(incomingCount)}個に対し、生存余力は${formatNumber(margin)}個です。返し候補と積み候補の中から防御寄りに選んでいます。`;
  default:
    if (enemyRead.garbage_obstruct) {
      return `相手盤面はおじゃまに埋まり気味ですが、即キル候補は不足しています。${buildModeText(offense.neutral_build_type)}で次の攻めを作ります。`;
    }
    return `即時の返し・キル・潰しより、将来火力を伸ばす価値が高い局面です。最大返し${formatNumber(maxResponse)}個を見つつ積みを継続します。`;
  }
}

function decisionProcessRows(side, decision) {
  const strategy = side.strategy || {};
  const pending = side.pending || {};
  const enemyRead = side.enemy_read || {};
  const gaze = enemyRead.gaze || {};
  const incoming = strategy.incoming || {};
  const offense = strategy.offense || {};
  const build = strategy.build_quality || {};
  const battle = side.battle || {};

  return [
    {
      label: 'おじゃま',
      value: `頭上 ${formatNumber(pending.incoming)} / 送信 ${formatNumber(pending.outgoing)} / 余力 ${formatNumber(battle.survival_margin)}個`,
      note: `受け許容量 ${formatNumber(incoming.accept_limit ?? side.defense?.accept_limit)}個、最大返し ${formatNumber(battle.max_response_send)}個`,
      important: battle.status === 'critical' || battle.status === 'counter_required',
    },
    {
      label: '相手読み',
      value: `主砲 ${formatNumber(gaze.main?.send_total)}個 / 催促 ${formatNumber(gaze.harass?.send_total)}個 / 速攻 ${formatNumber(gaze.early?.send_total)}個`,
      note: `小盤面 ${yesNo(enemyRead.small_field)}、おじゃま埋まり ${yesNo(enemyRead.garbage_obstruct)}、読み遅延 ${formatNumber(enemyRead.delay)}`,
    },
    {
      label: '返し候補',
      value: `即主砲 ${summarizeBestAttack(incoming.immediate_main_return?.candidates)} / 小返し ${summarizeBestAttack(incoming.small_return)}`,
      note: `同期 ${summarizeBestAttack(incoming.syncro_return)} / 主砲返し ${summarizeBestAttack(incoming.main_return)} / 粘り ${summarizeBestAttack(incoming.desperate_return)}`,
      important: ['即主砲で相殺', 'クロス/同期返し', '小連鎖で返す', '主砲返し', '最大火力で粘る'].includes(decision),
    },
    {
      label: '攻め候補',
      value: `最大火力 ${formatNumber(offense.attack_max_send_total)}個 / キル必要 ${formatNumber(offense.kill?.attack_need)}`,
      note: `キル ${summarizeBestAttack(offense.kill?.candidates)} / 潰し ${summarizeBestAttack(offense.harass?.crush)} / 二段 ${summarizeBestAttack(offense.harass?.combo)}`,
      important: ['敵発火への速攻', 'キル狙い', '潰し', '二段催促'].includes(decision),
    },
    {
      label: '積み',
      value: `beam ${compactBuildSummary(build.beam_build)} / 通常 ${buildModeText(offense.neutral_build_type)}`,
      note: `防御時 ${buildModeText(incoming.fallback_build_type)}。FAST/FREESTYLE/ACは必要時にama内部で評価します`,
      important: decision === '積む' || decision === '受けて積む',
    },
  ];
}

function statusText(status) {
  const labels = {
    critical: '致死級',
    counter_required: '返し必須',
    can_accept: '受け可',
    stable: '安定',
  };
  return labels[status] || status || '-';
}

function battleLeaderText(evalData) {
  if (!evalData || !evalData.leader || evalData.leader === 'even') return '互角寄り';
  const confidence = { high: '強め', medium: 'やや', low: '薄め' }[evalData.confidence] || '';
  return `${evalData.leader.toUpperCase()} ${confidence}有利`;
}

function renderEvalSummary(data) {
  const summary = document.getElementById('eval-summary');
  if (data.battle_eval) {
    const p1 = data.battle_eval.players?.p1 || {};
    const p2 = data.battle_eval.players?.p2 || {};
    summary.textContent =
      `${battleLeaderText(data.battle_eval)}  ` +
      `生存余力 P1 ${formatNumber(p1.survival_margin)} / P2 ${formatNumber(p2.survival_margin)}  ` +
      data.battle_eval.reason;
    summary.classList.remove('muted');
    return;
  }

  if (data.eval) {
    const diff = Number(data.eval.p1_minus_p2);
    summary.textContent = `${data.eval.leader.toUpperCase()} 有利  単独積み差分 ${diff.toLocaleString()}`;
    summary.classList.remove('muted');
  } else {
    summary.textContent = '評価不能';
    summary.classList.add('muted');
  }
}

function addStrategyHeading(container, label) {
  const heading = document.createElement('div');
  heading.className = 'strategy-heading';
  heading.textContent = label;
  container.appendChild(heading);
}

function addDecisionCard(container, title, body) {
  const card = document.createElement('div');
  card.className = 'decision-card';
  const h = document.createElement('div');
  h.className = 'decision-title';
  h.textContent = title;
  const p = document.createElement('p');
  p.textContent = body;
  card.append(h, p);
  container.appendChild(card);
}

function addStrategyRow(container, label, value, important = false, note = '') {
  const row = document.createElement('div');
  row.className = `strategy-row ${important ? 'important' : ''}`;
  const key = document.createElement('span');
  key.textContent = label;
  const val = document.createElement('div');
  val.className = 'strategy-value';
  const main = document.createElement('strong');
  main.textContent = String(value);
  val.appendChild(main);
  if (note) {
    const detail = document.createElement('small');
    detail.textContent = String(note);
    val.appendChild(detail);
  }
  row.append(key, val);
  container.appendChild(row);
}

function renderStrategy(id, side) {
  const el = document.getElementById(id);
  el.innerHTML = '';
  if (!side || side.error) {
    el.textContent = side?.error || '戦略診断なし';
    el.classList.add('muted');
    return;
  }
  el.classList.remove('muted');

  const strategy = side.strategy || {};
  const offense = strategy.offense || {};
  const build = strategy.build_quality || {};
  const move = side.ama_move || {};
  const decision = inferDecision(side);
  const explanation = decisionExplanation(side, decision);

  addDecisionCard(el, `${decision} / ${placementText(move.placement)} / eval ${formatNumber(move.eval)}`, explanation);

  addStrategyHeading(el, '判断過程');
  for (const row of decisionProcessRows(side, decision)) {
    addStrategyRow(el, row.label, row.value, row.important, row.note);
  }

  addStrategyHeading(el, '詳細');
  addStrategyRow(
    el,
    '自分火力',
    `${formatNumber(offense.attack_max_send_total)}個 / score ${formatNumber(offense.attack_max_score_total)}`,
    false,
    `発火候補 ${actionArraySummary(side.self_attack_candidates)}`
  );
  addStrategyRow(
    el,
    '相手防御',
    `1手 ${formatNumber(offense.enemy_defense_1_send)}個 / 2手 ${formatNumber(offense.enemy_defense_2_send)}個`,
    false,
    `敵候補 ${actionArraySummary(side.enemy_attack_candidates)}`
  );
  addStrategyRow(
    el,
    '盤面',
    `ぷよ ${formatNumber(side.field?.count)} / おじゃま ${formatNumber(side.field?.garbage_count)} / 露出 ${formatNumber(side.field?.unburied_count)}`,
    false,
    `積み評価 ${buildSummary(build.beam_build)}`
  );
}

function renderMessages(text) {
  document.getElementById('messages').textContent = text || '';
}

async function askAma() {
  const analyzeBtn = document.getElementById('analyze-btn');
  analyzeBtn.disabled = true;
  if (!evalWorkerReady) {
    setStatus('ama初期化中...');
    await initEvalWorker();
  }
  setStatus('ama評価中...');
  const timeoutSec = Number(document.getElementById('eval-timeout').value) || 60;
  const body = {
    p1: normalizePlayerForAma(state.p1),
    p2: normalizePlayerForAma(state.p2),
    options: {
      width: Number(document.getElementById('beam-width').value) || 500,
      depth: Number(document.getElementById('beam-depth').value) || 24,
      timeout_sec: timeoutSec,
      no_fire: document.getElementById('no-fire').checked,
      weights: 'build',
      skip_dfs_build: true,
    },
  };
  const raw = await queryEvalWasm(body, Math.max(10000, timeoutSec * 1000 + 5000));
  const data = prepareEvalResponse(raw);
  if (data.error) {
    setStatus(data.error || '評価に失敗しました', true);
    analyzeBtn.disabled = false;
    return;
  }

  renderCandidates('p1-candidates', data.players?.p1);
  renderCandidates('p2-candidates', data.players?.p2);
  renderStrategy('p1-strategy', data.strategy?.p1);
  renderStrategy('p2-strategy', data.strategy?.p2);
  renderEvalSummary(data);
  renderMessages(JSON.stringify(data, null, 2));
  setStatus('評価完了');
  analyzeBtn.disabled = false;
}

function setup() {
  const buildDate = document.getElementById('build-date');
  if (buildDate) buildDate.textContent = window.BUILD_DATE || '?';
  buildPalette();
  renderAll();
  initEvalWorker().catch(err => setStatus(err.message, true));

  const input = document.getElementById('image-input');
  input.addEventListener('click', () => {
    input.value = '';
  });
  input.addEventListener('change', () => {
    selectedFile = input.files?.[0] || null;
    if (selectedFile) {
      const img = document.getElementById('preview-image');
      if (previewUrl) URL.revokeObjectURL(previewUrl);
      previewUrl = URL.createObjectURL(selectedFile);
      img.src = previewUrl;
      img.style.display = 'block';
      analyzeImage().catch(err => {
        document.getElementById('analyze-btn').disabled = false;
        setStatus(err.message, true);
      });
    }
  });
  document.getElementById('analyze-btn').addEventListener('click', () => {
    askAma().catch(err => {
      document.getElementById('analyze-btn').disabled = false;
      setStatus(err.message, true);
    });
  });
}

document.addEventListener('DOMContentLoaded', setup);
