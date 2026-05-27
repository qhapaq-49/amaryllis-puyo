'use strict';

const COLORS = ['.', 'R', 'Y', 'G', 'B', 'P', '#'];
const COLOR_LABELS = { '.': '空', R: 'R', Y: 'Y', G: 'G', B: 'B', P: 'P', '#': '×' };
const PLAYERS = ['p1', 'p2'];

let selectedColor = 'R';
let selectedFile = null;
let state = {
  p1: emptyPlayer(),
  p2: emptyPlayer(),
};

function emptyPlayer() {
  return {
    field: Array.from({ length: 13 }, () => '......'),
    current_piece: ['R', 'R'],
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

function normalizePair(pair) {
  if (!Array.isArray(pair) || pair.length !== 2) return ['R', 'R'];
  return [
    COLORS.includes(pair[0]) && pair[0] !== '.' && pair[0] !== '#' ? pair[0] : 'R',
    COLORS.includes(pair[1]) && pair[1] !== '.' && pair[1] !== '#' ? pair[1] : 'R',
  ];
}

function normalizePlayer(player) {
  const next = emptyPlayer();
  if (Array.isArray(player.field) && player.field.length === 13) {
    next.field = player.field.map(row => {
      const chars = String(row).slice(0, 6).padEnd(6, '.').split('');
      return chars.map(c => COLORS.includes(c) ? c : '.').join('');
    });
  }
  next.current_piece = player.current_piece ? normalizePair(player.current_piece) : ['R', 'R'];
  const queue = Array.isArray(player.queue) ? player.queue : [];
  next.queue = [normalizePair(queue[0]), normalizePair(queue[1])];
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
  document.getElementById('ask-btn').disabled = false;
}

async function analyzeImage() {
  if (!selectedFile) return;
  setStatus('解析中...');
  const imageBase64 = await readFileAsDataURL(selectedFile);
  const res = await fetch('/api/analyze', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      filename: selectedFile.name,
      image_base64: imageBase64,
    }),
  });
  const data = await res.json();
  if (!res.ok || data.error) {
    setStatus(data.error || '解析に失敗しました', true);
    return;
  }
  state.p1 = normalizePlayer(data.p1 || {});
  state.p2 = normalizePlayer(data.p2 || {});
  renderAll();
  renderMessages(JSON.stringify(data, null, 2));
  setStatus('解析完了。必要なら盤面・ツモ・頭上おじゃまを修正してください。');
}

function readFileAsDataURL(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(reader.error || new Error('file read failed'));
    reader.readAsDataURL(file);
  });
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

function attackSummary(summary) {
  const count = Number(summary?.count || 0);
  if (!summary?.best) return `${count}件`;
  const attack = summary.best.attack || {};
  return `${count}件 / ${placementText(summary.best.placement)} ${formatNumber(attack.send_total)}個 ${formatNumber(attack.chain_count)}連鎖`;
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

function addStrategyRow(container, label, value, important = false) {
  const row = document.createElement('div');
  row.className = `strategy-row ${important ? 'important' : ''}`;
  const key = document.createElement('span');
  key.textContent = label;
  const val = document.createElement('strong');
  val.textContent = String(value);
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
  const pending = side.pending || {};
  const enemyRead = side.enemy_read || {};
  const gaze = enemyRead.gaze || {};
  const incoming = strategy.incoming || {};
  const offense = strategy.offense || {};
  const build = strategy.build_quality || {};
  const move = side.ama_move || {};
  const battle = side.battle || {};
  const decision = inferDecision(side);

  addStrategyHeading(el, '総合');
  addStrategyRow(el, '生存余力', `${formatNumber(battle.survival_margin)}個 / 状態 ${statusText(battle.status)}`, battle.status === 'critical');
  addStrategyRow(el, 'おじゃま差', `受け ${formatNumber(pending.incoming)} / 送り ${formatNumber(pending.outgoing)} / balance ${formatNumber(pending.balance)}`);

  addStrategyHeading(el, '自分火力');
  addStrategyRow(el, '最大火力', `${formatNumber(offense.attack_max_send_total)}個 / score ${formatNumber(offense.attack_max_score_total)}`);
  addStrategyRow(el, '発火候補', actionArraySummary(side.self_attack_candidates));
  addStrategyRow(el, '積み評価', `beam ${buildSummary(build.beam_build)} / freestyle ${buildSummary(build.freestyle_build)}`);

  addStrategyHeading(el, '相手火力');
  addStrategyRow(el, '敵読み', `主砲 ${formatNumber(gaze.main?.send_total)}個 / 催促 ${formatNumber(gaze.harass?.send_total)}個 / 速攻 ${formatNumber(gaze.early?.send_total)}個`);
  addStrategyRow(el, '敵防御', `1手 ${formatNumber(offense.enemy_defense_1_send)}個 / 2手 ${formatNumber(offense.enemy_defense_2_send)}個`);
  addStrategyRow(el, '敵候補', actionArraySummary(side.enemy_attack_candidates));

  addStrategyHeading(el, '戦略判断');
  addStrategyRow(el, 'ama判断', `${decision} / ${placementText(move.placement)} eval ${formatNumber(move.eval)}`, true);
  addStrategyRow(el, '受け許容量', `${formatNumber(incoming.accept_limit)}個 / 受け ${incoming.can_accept ? '可' : '不可'} / ${incoming.accept_build_type || '-'}`);
  addStrategyRow(el, '返し候補', `即主砲 ${attackSummary(incoming.immediate_main_return?.candidates)} / 小返し ${attackSummary(incoming.small_return)} / 主砲返し ${attackSummary(incoming.main_return)}`);
  addStrategyRow(el, 'キル判定', `${offense.kill?.checked ? '確認中' : '条件外'} / 必要 ${formatNumber(offense.kill?.attack_need)}個 / ${attackSummary(offense.kill?.candidates)}`);
  addStrategyRow(el, '催促候補', `潰し ${attackSummary(offense.harass?.crush)} / 二段 ${attackSummary(offense.harass?.combo)} / 迎撃 ${attackSummary(offense.counter_attack_during_enemy_chain)}`);

  addStrategyHeading(el, '論拠');
  addStrategyRow(el, '速攻根拠', `可否 ${offense.harass?.eligible ? 'yes' : 'no'} / 敵3列 ${formatNumber(offense.harass?.enemy_column_3_height)} / 潰し差 ${formatNumber(offense.harass?.crush_margin)}個`);
  addStrategyRow(el, '敵状態', `小盤面 ${enemyRead.small_field ? 'yes' : 'no'} / おじゃま埋まり ${enemyRead.garbage_obstruct ? 'yes' : 'no'}`);
  addStrategyRow(el, '盤面', `ぷよ ${formatNumber(side.field?.count)} / おじゃま ${formatNumber(side.field?.garbage_count)} / 露出 ${formatNumber(side.field?.unburied_count)}`);
}

function renderMessages(text) {
  document.getElementById('messages').textContent = text || '';
}

async function askAma() {
  setStatus('ama評価中...');
  const body = {
    p1: state.p1,
    p2: state.p2,
    options: {
      width: Number(document.getElementById('beam-width').value) || 500,
      depth: Number(document.getElementById('beam-depth').value) || 24,
      timeout_sec: Number(document.getElementById('eval-timeout').value) || 60,
      no_fire: document.getElementById('no-fire').checked,
      weights: 'build',
    },
  };
  const res = await fetch('/api/evaluate', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const data = await res.json();
  if (!res.ok || data.error) {
    setStatus(data.error || '評価に失敗しました', true);
    return;
  }

  renderCandidates('p1-candidates', data.players?.p1);
  renderCandidates('p2-candidates', data.players?.p2);
  renderStrategy('p1-strategy', data.strategy?.p1);
  renderStrategy('p2-strategy', data.strategy?.p2);
  renderEvalSummary(data);
  renderMessages(JSON.stringify(data, null, 2));
  setStatus('評価完了');
}

function setup() {
  buildPalette();
  renderAll();
  document.getElementById('ask-btn').disabled = true;

  const input = document.getElementById('image-input');
  input.addEventListener('change', () => {
    selectedFile = input.files?.[0] || null;
    document.getElementById('analyze-btn').disabled = !selectedFile;
    if (selectedFile) {
      const img = document.getElementById('preview-image');
      img.src = URL.createObjectURL(selectedFile);
      img.style.display = 'block';
      setStatus(selectedFile.name);
    }
  });
  document.getElementById('analyze-btn').addEventListener('click', () => {
    analyzeImage().catch(err => setStatus(err.message, true));
  });
  document.getElementById('ask-btn').addEventListener('click', () => {
    askAma().catch(err => setStatus(err.message, true));
  });
}

document.addEventListener('DOMContentLoaded', setup);
