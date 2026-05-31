'use strict';

const COLORS = ['.', 'R', 'Y', 'G', 'B', 'P', '#'];
const COLOR_LABELS = { '.': '空', R: 'R', Y: 'Y', G: 'G', B: 'B', P: 'P', '#': '×' };
const PLAYERS = ['p1', 'p2'];

const TERM_DEFINITIONS = [
  {
    term: '読めた最大連鎖',
    body: '相手読みの最大値。現在ツモ+NEXT1までを実際に置く探索と、その後の発火点検出を含む最大スコアです。1手限定ではありません。',
  },
  {
    term: '潜在最大連鎖',
    body: '今の盤面からキーぷよを仮に足して見た将来火力です。実際のツモ順は保証しない、盤面ポテンシャル寄りの値です。',
  },
  {
    term: '短連鎖候補',
    body: '3連鎖以下で、盤面の崩れが大きすぎない攻撃候補です。一般的には催促・小連鎖に近い候補です。',
  },
  {
    term: '即発火返し',
    body: '相手の着弾猶予内に発火でき、頭上おじゃまを相殺できる返しです。現在ツモ1手だけとは限りません。',
  },
  {
    term: '敵発火への速攻',
    body: '相手が連鎖中で、こちらの速い攻撃が相手の着地前後に間に合う時の攻撃候補です。自分が防御側とは限りません。',
  },
  {
    term: '同期返し',
    body: '相手の連鎖にタイミングを合わせ、相手の攻撃量を上回る速い返しです。量だけでなく着弾の近さも見ます。',
  },
  {
    term: '小返し',
    body: '頭上おじゃまを返しつつ、発火後の盤面を比較的残す返しです。相手の次の短連鎖も加味します。',
  },
  {
    term: '大連鎖返し',
    body: '小返しでは足りない時に使う大きめの返しです。発火後の残り盤面が少ない候補がここに入ります。',
  },
  {
    term: 'キル必要',
    body: '相手の読めた最大連鎖と盤面の最低列から、埋め切るのに必要そうなおじゃま数を見積もった値です。',
  },
  {
    term: '潰し',
    body: '短めの攻撃で相手の防御候補を上回る手です。自分の盤面を残せるか、形を壊しすぎないかも見ます。',
  },
  {
    term: '二段催促',
    body: '小さな催促を打った後に大きな追撃が残る候補です。催促量と追撃量の両方を条件にします。',
  },
  {
    term: '頭上/送信',
    body: '頭上はそのプレイヤーに降る予定のおじゃま、送信は相手に送っている予定のおじゃまです。画面上の頭上おじゃまから差し引いて見ます。',
  },
  {
    term: '受け許容量',
    body: '今の盤面で受けても致命傷になりにくいおじゃま数の目安です。3列目の高さ、盤面のぷよ数、おじゃま数から決めます。',
  },
  {
    term: '防御1手/防御2手',
    body: '相手が短い猶予で返せる防御火力です。1手はかなり即時、2手は少し猶予ありで、盤面を一定以上残す候補だけを見ます。',
  },
  {
    term: '生存余力',
    body: '受け許容量+最大返し-頭上おじゃまの概算です。勝率ではなく、当面しのげるかを見る診断値です。',
  },
  {
    term: '積み評価',
    body: '入力されているツモ列でamaのBUILD評価をした値です。将来火力、形、連結、無駄消し、14段目の浪費などを見ます。',
  },
  {
    term: '積みモード',
    body: 'BUILDは通常の長期形重視、FASTは短期対応重視、FREESTYLEは形制約を緩めた積み、ACは全消しや受け寄りの積みです。',
  },
];

let selectedColor = 'R';
let selectedFile = null;
let selectedVideoFile = null;
let previewUrl = null;
let videoPreviewUrl = null;
let videoStates = [];
let activeVideoStateIndex = -1;
let videoScanCancel = false;
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
  const puyoColors = ['R', 'Y', 'G', 'B', 'P'];
  const weights = new Map();
  const order = [];
  const add = (c, weight) => {
    if (!puyoColors.includes(c)) return;
    if (!weights.has(c)) order.push(c);
    weights.set(c, (weights.get(c) || 0) + weight);
  };
  for (const row of player.field || []) {
    for (const c of String(row)) add(c, 1);
  }
  if (player.current_piece) {
    add(player.current_piece[0], 50);
    add(player.current_piece[1], 50);
  }
  const queue = Array.isArray(player.queue) ? player.queue : [];
  queue.forEach((pair, i) => {
    if (!Array.isArray(pair)) return;
    const weight = i === 0 ? 30 : 20;
    add(pair[0], weight);
    add(pair[1], weight);
  });
  const firstSeen = new Map(order.map((c, i) => [c, i]));
  return order
    .sort((a, b) => (weights.get(b) - weights.get(a)) || firstSeen.get(a) - firstSeen.get(b))
    .slice(0, 4);
}

function normalizePlayerForAma(player) {
  const amaColors = ['R', 'Y', 'G', 'B'];
  const colors = activeColors(player);
  const mapping = { '.': '.', '#': '#' };
  colors.forEach((c, i) => { mapping[c] = amaColors[i]; });
  const fallbackColor = colors.length ? mapping[colors[0]] : amaColors[0];
  const mapPairColor = c => mapping[c] && mapping[c] !== '.' && mapping[c] !== '#' ? mapping[c] : fallbackColor;

  const field = (player.field || []).map(row => String(row).slice(0, 6).padEnd(6, '.').split('').map(c => mapping[c] || '.').join(''));
  if (field.length !== 13) throw new Error('field must contain exactly 13 rows');

  const queue = [];
  const pairs = [];
  if (player.current_piece) pairs.push(player.current_piece);
  pairs.push(...(player.queue || []));
  for (const pair of pairs) {
    if (!Array.isArray(pair) || pair.length !== 2) continue;
    queue.push([mapPairColor(pair[0]), mapPairColor(pair[1])]);
  }
  while (queue.length < 3) queue.push([fallbackColor, fallbackColor]);
  return { field, queue: queue.slice(0, 3), garbage: Math.max(0, Number(player.garbage) || 0) };
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

function decisionLabelFromStage(stage) {
  const labels = {
    'defense.all_clear_return': '全消し返し',
    'defense.immediate_return': '即発火で相殺',
    'defense.syncro_return': 'クロス/同期返し',
    'defense.accept_build': '受けて積む',
    'defense.small_return': '小連鎖で返す',
    'defense.main_return': '大連鎖返し',
    'defense.desperate_return': '最大火力で粘る',
    'defense.fallback_build': '防御判断',
    'offense.counter_during_enemy_chain': '敵発火への速攻',
    'offense.kill': 'キル狙い',
    'offense.harass_crush': '潰し',
    'offense.harass_combo': '二段催促',
    'neutral.build': '積む',
  };
  return labels[stage] || '';
}

function stageExplanation(stage) {
  const explanations = {
    'defense.all_clear_return': 'C++のai::thinkは、相手の序盤全消し連鎖に間に合う全消し返し分岐を通りました。',
    'defense.immediate_return': 'C++のai::thinkは、頭上おじゃまを相殺できる即発火返し分岐を通りました。',
    'defense.syncro_return': 'C++のai::thinkは、相手連鎖に速度を合わせる同期返し分岐を通りました。',
    'defense.accept_build': 'C++のai::thinkは、頭上おじゃまを受けられると判断し、撃たずに積む分岐を通りました。',
    'defense.small_return': 'C++のai::thinkは、盤面を残しやすい小返し分岐を通りました。',
    'defense.main_return': 'C++のai::thinkは、小返しではなく大きめの返しを選ぶ分岐を通りました。',
    'defense.desperate_return': 'C++のai::thinkは、十分な返しがない中で最大火力に近い返しを選ぶ分岐を通りました。',
    'defense.fallback_build': 'C++のai::thinkは、防御側の返し候補を採用せず、防御用の積み分岐を通りました。',
    'offense.counter_during_enemy_chain': 'C++のai::thinkは、相手連鎖中に間に合う速い攻撃を合わせる分岐を通りました。',
    'offense.kill': 'C++のai::thinkは、相手盤面を埋め切れるキル候補を選ぶ分岐を通りました。',
    'offense.harass_crush': 'C++のai::thinkは、相手防御を上回る潰し候補を選ぶ分岐を通りました。',
    'offense.harass_combo': 'C++のai::thinkは、小催促から追撃を残す二段催促分岐を通りました。',
    'neutral.build': 'C++のai::thinkは、即時攻撃や防御分岐を採用せず、通常の積み分岐を通りました。',
  };
  return explanations[stage] || '';
}

function inferDecision(side) {
  const traced = decisionLabelFromStage(side?.ama_move?.decision_stage);
  if (traced) return traced;
  const strategy = side?.strategy || {};
  const incoming = strategy.incoming || {};
  const offense = strategy.offense || {};

  if (incoming.active) {
    if (hasAmaMove(incoming.all_clear_return)) return '全消し返し';
    if (hasAmaMove(incoming.immediate_main_return)) return '即発火で相殺';
    if (hasAmaMove(incoming.syncro_return)) return 'クロス/同期返し';
    if (hasAmaMove(incoming.small_return)) return '小連鎖で返す';
    if (hasAmaMove(incoming.main_return)) return '大連鎖返し';
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
  const traced = stageExplanation(side?.ama_move?.decision_stage);
  if (traced) return traced;
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
  case '即発火で相殺':
    return `頭上${formatNumber(incomingCount)}個に対し、即発火候補が相殺条件を満たしています。最良候補は${summarizeBestAttack(incoming.immediate_main_return?.candidates)}です。`;
  case 'クロス/同期返し':
    return `相手発火に速度を合わせられる返しがあります。量と着弾の速さを優先し、${summarizeBestAttack(incoming.syncro_return)}を選びます。`;
  case '受けて積む':
    return `頭上${formatNumber(incomingCount)}個は受け許容量${formatNumber(acceptLimit)}個の範囲内です。撃たずに${buildModeText(incoming.accept_build_type)}で積みます。`;
  case '小連鎖で返す':
    return `受けだけでは足りないため、盤面を残しやすい小返しを優先します。最良候補は${summarizeBestAttack(incoming.small_return)}です。`;
  case '大連鎖返し':
    return `小返しや受けでは不足するため、大連鎖返しを選びます。候補は${summarizeBestAttack(incoming.main_return)}です。`;
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
  const move = side.ama_move || {};
  const stage = move.decision_stage || move.trace?.stage || '-';
  const reason = move.decision_reason || move.trace?.reason || '-';
  const buildStage = move.build_stage || move.trace?.build_stage || '-';
  const buildReason = move.build_reason || move.trace?.build_reason || '-';

  return [
    {
      label: '分岐ログ',
      value: `stage ${stage}`,
      note: `reason ${reason} / build ${buildStage}: ${buildReason}`,
      important: true,
    },
    {
      label: 'おじゃま',
      value: `頭上 ${formatNumber(pending.incoming)} / 送信 ${formatNumber(pending.outgoing)} / 余力 ${formatNumber(battle.survival_margin)}個`,
      note: `受け許容量 ${formatNumber(incoming.accept_limit ?? side.defense?.accept_limit)}個、最大返し ${formatNumber(battle.max_response_send)}個`,
      important: battle.status === 'critical' || battle.status === 'counter_required',
    },
    {
      label: '相手読み',
      value: `読めた最大 ${formatNumber(gaze.main?.send_total)}個 / 短連鎖 ${formatNumber(gaze.harass?.send_total)}個 / 防御1手 ${formatNumber(gaze.defence_1?.send_total)}個`,
      note: `潜在最大 ${formatNumber(gaze.main_q?.send_total)}個 / 防御2手 ${formatNumber(gaze.defence_2?.send_total)}個 / 小盤面 ${yesNo(enemyRead.small_field)} / おじゃま埋まり ${yesNo(enemyRead.garbage_obstruct)}`,
    },
    {
      label: '返し候補',
      value: `即発火 ${summarizeBestAttack(incoming.immediate_main_return?.candidates)} / 小返し ${summarizeBestAttack(incoming.small_return)}`,
      note: `同期 ${summarizeBestAttack(incoming.syncro_return)} / 大連鎖返し ${summarizeBestAttack(incoming.main_return)} / 粘り ${summarizeBestAttack(incoming.desperate_return)}`,
      important: ['即発火で相殺', 'クロス/同期返し', '小連鎖で返す', '大連鎖返し', '最大火力で粘る'].includes(decision),
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
    `攻撃候補 ${actionArraySummary(side.self_attack_candidates)}`
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

function renderTermDefinitions() {
  const list = document.getElementById('term-definitions');
  if (!list) return;
  list.innerHTML = '';
  for (const item of TERM_DEFINITIONS) {
    const term = document.createElement('dt');
    term.textContent = item.term;
    const body = document.createElement('dd');
    body.textContent = item.body;
    list.append(term, body);
  }
}

function renderMessages(text) {
  document.getElementById('messages').textContent = text || '';
}


function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function clampNumber(value, min, max, fallback) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

function waitForVideoMetadata(video) {
  if (video.readyState >= 1 && Number.isFinite(video.duration)) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const cleanup = () => {
      video.removeEventListener('loadedmetadata', onReady);
      video.removeEventListener('error', onError);
    };
    const onReady = () => { cleanup(); resolve(); };
    const onError = () => { cleanup(); reject(new Error('動画を読み込めませんでした')); };
    video.addEventListener('loadedmetadata', onReady, { once: true });
    video.addEventListener('error', onError, { once: true });
  });
}

function seekVideo(video, time) {
  const target = Math.max(0, Math.min(time, Number.isFinite(video.duration) ? video.duration : time));
  if (Math.abs(video.currentTime - target) < 0.025 && video.readyState >= 2) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error('動画シークがタイムアウトしました'));
    }, 8000);
    const cleanup = () => {
      clearTimeout(timer);
      video.removeEventListener('seeked', onSeeked);
      video.removeEventListener('error', onError);
    };
    const onSeeked = () => { cleanup(); resolve(); };
    const onError = () => { cleanup(); reject(new Error('動画シークに失敗しました')); };
    video.addEventListener('seeked', onSeeked, { once: true });
    video.addEventListener('error', onError, { once: true });
    video.currentTime = target;
  });
}

function formatTime(seconds) {
  const total = Math.max(0, Math.floor(Number(seconds) || 0));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const frac = Math.floor(((Number(seconds) || 0) - total) * 10);
  const base = h > 0
    ? `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`
    : `${m}:${String(s).padStart(2, '0')}`;
  return `${base}.${Math.max(0, frac)}`;
}

function clonePlayers(players) {
  return {
    p1: normalizePlayer(players.p1 || {}),
    p2: normalizePlayer(players.p2 || {}),
  };
}

function readablePlayer(raw) {
  return raw && !raw.error && Array.isArray(raw.field) && raw.field.length === 13 && Array.isArray(raw.queue);
}

function readableScreen(data) {
  return readablePlayer(data?.p1) && readablePlayer(data?.p2);
}

function videoStateSignature(players) {
  return JSON.stringify({
    p1: {
      field: players.p1.field,
      current: players.p1.current_piece,
      queue: players.p1.queue,
      garbage: players.p1.garbage,
    },
    p2: {
      field: players.p2.field,
      current: players.p2.current_piece,
      queue: players.p2.queue,
      garbage: players.p2.garbage,
    },
  });
}

function estimateReadConfidence(raw, players) {
  if (!readableScreen(raw)) return 0;
  let score = 1;
  for (const key of PLAYERS) {
    if (!raw[key]?.current_piece) score -= 0.10;
    const visible = players[key].field.join('').replace(/[.]/g, '').length;
    if (visible < 8) score -= 0.10;
    if (players[key].queue.length < 2) score -= 0.10;
  }
  return Math.max(0, Math.min(1, score));
}

function videoStateEvalLabel(entry) {
  if (entry.status === 'error') return `error: ${entry.error || '評価失敗'}`;
  if (entry.status === 'evaluating') return 'ama評価中';
  if (entry.evalData?.battle_eval) return battleLeaderText(entry.evalData.battle_eval);
  if (entry.status === 'done') return '評価完了';
  return '評価待ち';
}

function compactVideoState(entry) {
  return {
    index: entry.index,
    time: entry.time,
    scanIndex: entry.scanIndex,
    confidence: entry.confidence,
    status: entry.status,
    error: entry.error,
    p1: entry.players?.p1,
    p2: entry.players?.p2,
    eval: entry.evalData ? {
      battle_eval: entry.evalData.battle_eval,
      p1_stage: entry.evalData.strategy?.p1?.ama_move?.decision_stage,
      p2_stage: entry.evalData.strategy?.p2?.ama_move?.decision_stage,
      p1_move: entry.evalData.strategy?.p1?.ama_move?.placement,
      p2_move: entry.evalData.strategy?.p2?.ama_move?.placement,
    } : null,
  };
}

function renderVideoStates() {
  const summary = document.getElementById('video-state-summary');
  const list = document.getElementById('video-states');
  if (!summary || !list) return;
  list.innerHTML = '';
  if (videoStates.length === 0) {
    summary.textContent = '未抽出';
    summary.classList.add('muted');
    return;
  }
  const done = videoStates.filter(s => s.status === 'done').length;
  const errors = videoStates.filter(s => s.status === 'error').length;
  summary.textContent = `${videoStates.length}局面 / 評価済み ${done} / エラー ${errors}`;
  summary.classList.remove('muted');
  for (const entry of videoStates) {
    const li = document.createElement('li');
    li.className = `video-state ${entry.status || 'pending'} ${entry.index === activeVideoStateIndex ? 'active' : ''}`;
    const body = document.createElement('div');
    const title = document.createElement('strong');
    title.textContent = `state ${entry.index}  ${formatTime(entry.time)}  ${videoStateEvalLabel(entry)}`;
    const detail = document.createElement('small');
    detail.textContent = `confidence ${Math.round(entry.confidence * 100)}% / scan ${entry.scanIndex}`;
    body.append(title, detail);
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.textContent = '表示';
    btn.addEventListener('click', () => applyVideoState(entry.index));
    li.append(body, btn);
    list.appendChild(li);
  }
}

function applyVideoState(index) {
  const entry = videoStates[index];
  if (!entry) return;
  activeVideoStateIndex = index;
  state = clonePlayers(entry.players);
  renderAll();
  if (entry.evalData && !entry.evalData.error) renderEvalResult(entry.evalData);
  renderMessages(JSON.stringify({ state: entry, eval: entry.evalData || null }, null, 2));
  const video = document.getElementById('preview-video');
  if (video && Number.isFinite(entry.time) && Math.abs(video.currentTime - entry.time) > 0.05) {
    video.currentTime = entry.time;
  }
  renderVideoStates();
  setStatus(`state ${index} を表示中`);
}

async function evaluateVideoState(entry) {
  entry.status = 'evaluating';
  renderVideoStates();
  try {
    const data = await evaluatePlayers(entry.players, `state ${entry.index} ama評価中...`);
    if (data.error) throw new Error(data.error);
    entry.evalData = data;
    entry.status = 'done';
    if (entry.index === activeVideoStateIndex) renderEvalResult(data);
  } catch (err) {
    entry.status = 'error';
    entry.error = err.message || String(err);
  }
  renderVideoStates();
}

async function scanVideoTrace() {
  if (!selectedVideoFile) return;
  if (typeof window.analyzeScreenImageData !== 'function') {
    setStatus('画像解析モジュールが読み込まれていません', true);
    return;
  }
  const video = document.getElementById('preview-video');
  const scanBtn = document.getElementById('video-scan-btn');
  const cancelBtn = document.getElementById('video-cancel-btn');
  const analyzeBtn = document.getElementById('analyze-btn');
  videoScanCancel = false;
  scanBtn.disabled = true;
  cancelBtn.disabled = false;
  analyzeBtn.disabled = true;
  videoStates = [];
  activeVideoStateIndex = -1;
  renderVideoStates();

  const stats = { scanned: 0, unreadable: 0, unstable: 0, duplicates: 0 };
  try {
    await waitForVideoMetadata(video);
    if (!evalWorkerReady) {
      setStatus('ama初期化中...');
      await initEvalWorker();
    }
    const step = clampNumber(document.getElementById('video-step').value, 0.25, 5, 0.75);
    const limitMin = clampNumber(document.getElementById('video-limit-min').value, 1, 120, 10);
    const maxStates = Math.floor(clampNumber(document.getElementById('video-max-states').value, 1, 1000, 80));
    const stableFrames = Math.floor(clampNumber(document.getElementById('video-stable-frames').value, 1, 5, 2));
    const start = Math.max(0, Math.min(video.currentTime || 0, video.duration || 0));
    const end = Math.min(video.duration || start, start + limitMin * 60);
    const scale = Math.min(1, 1280 / Math.max(1, video.videoWidth || 1280));
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.round((video.videoWidth || 1280) * scale));
    canvas.height = Math.max(1, Math.round((video.videoHeight || 720) * scale));
    const ctx = canvas.getContext('2d', { willReadFrequently: true });

    let lastSignature = '';
    let acceptedSignature = '';
    let repeat = 0;
    let scanIndex = 0;

    for (let t = start; t <= end && videoStates.length < maxStates; t += step) {
      if (videoScanCancel) break;
      setStatus(`動画走査中 ${formatTime(t)} / ${formatTime(end)}  state ${videoStates.length}`);
      await seekVideo(video, t);
      ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
      stats.scanned++;
      scanIndex++;

      let raw;
      try {
        raw = window.analyzeScreenImageData(ctx.getImageData(0, 0, canvas.width, canvas.height));
      } catch (err) {
        stats.unreadable++;
        lastSignature = '';
        repeat = 0;
        continue;
      }
      if (!readableScreen(raw)) {
        stats.unreadable++;
        lastSignature = '';
        repeat = 0;
        continue;
      }

      const players = clonePlayers(raw);
      const signature = videoStateSignature(players);
      if (signature === lastSignature) repeat++;
      else {
        lastSignature = signature;
        repeat = 1;
      }

      if (repeat < stableFrames) {
        stats.unstable++;
        continue;
      }
      if (signature === acceptedSignature) {
        stats.duplicates++;
        continue;
      }

      const entry = {
        index: videoStates.length,
        time: t,
        scanIndex,
        confidence: estimateReadConfidence(raw, players),
        players,
        raw,
        signature,
        status: 'pending',
      };
      videoStates.push(entry);
      acceptedSignature = signature;
      renderVideoStates();
      applyVideoState(entry.index);
      analyzeBtn.disabled = true;
      await evaluateVideoState(entry);
      await delay(0);
    }

    const status = videoScanCancel ? '動画解析を中止しました' : '動画解析完了';
    setStatus(`${status}: ${videoStates.length}局面 / 走査 ${stats.scanned} / 読取失敗 ${stats.unreadable} / 重複 ${stats.duplicates}`);
    renderMessages(JSON.stringify({
      source: selectedVideoFile.name,
      stats,
      states: videoStates.map(compactVideoState),
    }, null, 2));
  } finally {
    scanBtn.disabled = !selectedVideoFile;
    cancelBtn.disabled = true;
    analyzeBtn.disabled = false;
  }
}

function evaluationPayload(players) {
  const timeoutSec = Number(document.getElementById('eval-timeout').value) || 60;
  return {
    timeoutSec,
    body: {
      p1: normalizePlayerForAma(players.p1),
      p2: normalizePlayerForAma(players.p2),
      options: {
        width: Number(document.getElementById('beam-width').value) || 500,
        depth: Number(document.getElementById('beam-depth').value) || 24,
        timeout_sec: timeoutSec,
        no_fire: document.getElementById('no-fire').checked,
        weights: 'build',
        skip_dfs_build: true,
      },
    },
  };
}

async function evaluatePlayers(players, statusMessage = 'ama評価中...') {
  if (!evalWorkerReady) {
    setStatus('ama初期化中...');
    await initEvalWorker();
  }
  setStatus(statusMessage);
  const { body, timeoutSec } = evaluationPayload(players);
  const raw = await queryEvalWasm(body, Math.max(10000, timeoutSec * 1000 + 5000));
  return prepareEvalResponse(raw);
}

function renderEvalResult(data) {
  renderCandidates('p1-candidates', data.players?.p1);
  renderCandidates('p2-candidates', data.players?.p2);
  renderStrategy('p1-strategy', data.strategy?.p1);
  renderStrategy('p2-strategy', data.strategy?.p2);
  renderEvalSummary(data);
}

async function askAma() {
  const analyzeBtn = document.getElementById('analyze-btn');
  analyzeBtn.disabled = true;
  try {
    const data = await evaluatePlayers(state);
    if (data.error) {
      setStatus(data.error || '評価に失敗しました', true);
      return;
    }
    renderEvalResult(data);
    renderMessages(JSON.stringify(data, null, 2));
    setStatus('評価完了');
  } finally {
    analyzeBtn.disabled = false;
  }
}

function setup() {
  const buildDate = document.getElementById('build-date');
  if (buildDate) buildDate.textContent = window.BUILD_DATE || '?';
  renderTermDefinitions();
  buildPalette();
  renderAll();
  renderVideoStates();
  initEvalWorker().catch(err => setStatus(err.message, true));

  const input = document.getElementById('image-input');
  const videoInput = document.getElementById('video-input');
  const img = document.getElementById('preview-image');
  const video = document.getElementById('preview-video');
  input.addEventListener('click', () => {
    input.value = '';
  });
  input.addEventListener('change', () => {
    selectedFile = input.files?.[0] || null;
    if (selectedFile) {
      selectedVideoFile = null;
      document.getElementById('video-scan-btn').disabled = true;
      if (videoPreviewUrl) URL.revokeObjectURL(videoPreviewUrl);
      videoPreviewUrl = null;
      video.pause();
      video.removeAttribute('src');
      video.style.display = 'none';
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
  videoInput.addEventListener('click', () => {
    videoInput.value = '';
  });
  videoInput.addEventListener('change', () => {
    selectedVideoFile = videoInput.files?.[0] || null;
    if (!selectedVideoFile) return;
    selectedFile = null;
    img.style.display = 'none';
    if (previewUrl) URL.revokeObjectURL(previewUrl);
    previewUrl = null;
    if (videoPreviewUrl) URL.revokeObjectURL(videoPreviewUrl);
    videoPreviewUrl = URL.createObjectURL(selectedVideoFile);
    video.src = videoPreviewUrl;
    video.style.display = 'block';
    videoStates = [];
    activeVideoStateIndex = -1;
    renderVideoStates();
    document.getElementById('video-scan-btn').disabled = false;
    setStatus(`${selectedVideoFile.name} を読み込みました`);
  });
  document.getElementById('video-scan-btn').addEventListener('click', () => {
    scanVideoTrace().catch(err => {
      document.getElementById('video-scan-btn').disabled = !selectedVideoFile;
      document.getElementById('video-cancel-btn').disabled = true;
      document.getElementById('analyze-btn').disabled = false;
      setStatus(err.message, true);
    });
  });
  document.getElementById('video-cancel-btn').addEventListener('click', () => {
    videoScanCancel = true;
    setStatus('動画解析を中止しています...');
  });
  document.getElementById('analyze-btn').addEventListener('click', () => {
    askAma().catch(err => {
      document.getElementById('analyze-btn').disabled = false;
      setStatus(err.message, true);
    });
  });
}

document.addEventListener('DOMContentLoaded', setup);
