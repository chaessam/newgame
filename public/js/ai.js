// 컴퓨터 상대 (초보 / 중수 / 고수)
import { W, H, GARBAGE, SPAWN_X, ROT_OFFSETS, scoreStep } from './core.js';

const N = W * H;

export const LEVELS = {
  easy: {
    name: '초보', actionDelay: 0.34, think: 0.6, softDrop: false, depth: 1,
    noise: 900, randomMove: 0.3, fireAt: 1, usePotential: false,
    answerTime: [4.5, 7.5], wrongRate: 0.3,
  },
  normal: {
    name: '중수', actionDelay: 0.14, think: 0.3, softDrop: true, depth: 1,
    noise: 120, randomMove: 0.04, fireAt: 3, usePotential: true,
    answerTime: [2.6, 4.5], wrongRate: 0.12,
  },
  hard: {
    name: '고수', actionDelay: 0.055, think: 0.12, softDrop: true, depth: 2,
    noise: 0, randomMove: 0, fireAt: 6, usePotential: true,
    answerTime: [1.4, 2.4], wrongRate: 0.03,
  },
};

// ---------- 빠른 보드 시뮬레이션 (Int8Array, -1 = 빈칸) ----------

export function toGrid(board) {
  const g = new Int8Array(N).fill(-1);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const c = board[y][x];
    if (c) g[y * W + x] = c.c;
  }
  return g;
}

function colTop(g, x) {
  for (let y = H - 1; y >= 0; y--) if (g[y * W + x] < 0) return y;
  return -1;
}

function dropPuyo(g, x, c) {
  const y = colTop(g, x);
  if (y >= 0) g[y * W + x] = c;
  return y;
}

export function placePair(g, x, r, ca, cb) {
  if (r === 0) { dropPuyo(g, x, ca); dropPuyo(g, x, cb); }
  else if (r === 2) { dropPuyo(g, x, cb); dropPuyo(g, x, ca); }
  else { dropPuyo(g, x, ca); dropPuyo(g, x + ROT_OFFSETS[r][0], cb); }
}

const visited = new Uint8Array(N);
const stack = new Int16Array(N);

function findGroupsGrid(g, minSize = 4) {
  visited.fill(0);
  const out = [];
  for (let i = W; i < N; i++) {
    const c = g[i];
    if (c < 0 || c === GARBAGE || visited[i]) continue;
    let sp = 0;
    const cells = [];
    stack[sp++] = i;
    visited[i] = 1;
    while (sp) {
      const k = stack[--sp];
      cells.push(k);
      const x = k % W;
      if (x > 0 && !visited[k - 1] && g[k - 1] === c) { visited[k - 1] = 1; stack[sp++] = k - 1; }
      if (x < W - 1 && !visited[k + 1] && g[k + 1] === c) { visited[k + 1] = 1; stack[sp++] = k + 1; }
      if (k - W >= W && !visited[k - W] && g[k - W] === c) { visited[k - W] = 1; stack[sp++] = k - W; }
      if (k + W < N && !visited[k + W] && g[k + W] === c) { visited[k + W] = 1; stack[sp++] = k + W; }
    }
    if (cells.length >= minSize) out.push({ c, cells });
  }
  return out;
}

function gravityGrid(g) {
  for (let x = 0; x < W; x++) {
    let write = H - 1;
    for (let y = H - 1; y >= 0; y--) {
      const c = g[y * W + x];
      if (c < 0) continue;
      if (y !== write) { g[write * W + x] = c; g[y * W + x] = -1; }
      write--;
    }
  }
}

export function simulateGrid(g) {
  let chain = 0, score = 0;
  for (;;) {
    const groups = findGroupsGrid(g);
    if (!groups.length) break;
    chain++;
    score += scoreStep(groups.map((gr) => ({ c: gr.c, cells: gr.cells })), chain);
    for (const gr of groups) {
      for (const k of gr.cells) {
        const x = k % W;
        const adj = [x > 0 ? k - 1 : -1, x < W - 1 ? k + 1 : -1, k - W >= W ? k - W : -1, k + W < N ? k + W : -1];
        for (const a of adj) if (a >= 0 && g[a] === GARBAGE) g[a] = -1;
      }
    }
    for (const gr of groups) for (const k of gr.cells) g[k] = -1;
    gravityGrid(g);
  }
  return { chain, score };
}

function heights(g) {
  const h = new Array(W);
  for (let x = 0; x < W; x++) h[x] = H - 1 - colTop(g, x);
  return h;
}

// 슬라임 1~2개를 더 놓았을 때 터질 수 있는 최대 연쇄 수 (잠재력)
function potentialChain(g, colors) {
  let best = 0;
  for (let x = 0; x < W; x++) {
    if (colTop(g, x) < 2) continue;
    for (let c = 0; c < colors; c++) {
      const t = g.slice();
      dropPuyo(t, x, c);
      let r = simulateGrid(t.slice());
      if (r.chain === 0) {
        dropPuyo(t, x, c);
        r = simulateGrid(t);
      }
      if (r.chain > best) best = r.chain;
    }
  }
  return best;
}

function evaluate(g, lvl, colors) {
  if (g[W + SPAWN_X] >= 0) return -1e9;
  let s = 0;
  // 같은 색끼리 붙어 있으면 좋음
  visited.fill(0);
  for (let i = W; i < N; i++) {
    const c = g[i];
    if (c < 0 || c === GARBAGE || visited[i]) continue;
    let sp = 0, size = 0;
    stack[sp++] = i; visited[i] = 1;
    while (sp) {
      const k = stack[--sp]; size++;
      const x = k % W;
      if (x > 0 && !visited[k - 1] && g[k - 1] === c) { visited[k - 1] = 1; stack[sp++] = k - 1; }
      if (x < W - 1 && !visited[k + 1] && g[k + 1] === c) { visited[k + 1] = 1; stack[sp++] = k + 1; }
      if (k - W >= W && !visited[k - W] && g[k - W] === c) { visited[k - W] = 1; stack[sp++] = k - W; }
      if (k + W < N && !visited[k + W] && g[k + W] === c) { visited[k + W] = 1; stack[sp++] = k + W; }
    }
    if (size === 2) s += 30;
    else if (size === 3) s += 90;
  }
  const h = heights(g);
  let total = 0;
  for (let x = 0; x < W; x++) {
    total += h[x];
    if (h[x] > 8) s -= (h[x] - 8) * (h[x] - 8) * 60;
    if (x < W - 1) s -= Math.abs(h[x] - h[x + 1]) * 12;
  }
  if (h[SPAWN_X] > 7) s -= (h[SPAWN_X] - 7) * 250;
  if (total > 36) s -= (total - 36) * 40;
  // 가운데보다 양 끝을 높게 쌓는 편이 연쇄 만들기에 좋음
  s += (h[0] + h[5] - h[2] - h[3]) * 4;
  if (lvl.usePotential) {
    const pot = potentialChain(g, colors);
    s += pot * pot * 160;
  }
  return s;
}

function reachable(g, x, r) {
  const cols = [x];
  if (r === 1) cols.push(x + 1);
  if (r === 3) cols.push(x - 1);
  const minC = Math.min(SPAWN_X, ...cols), maxC = Math.max(SPAWN_X, ...cols);
  for (let c = minC; c <= maxC; c++) if (g[W + c] >= 0) return false;
  return true;
}

function placements() {
  const list = [];
  for (let x = 0; x < W; x++) { list.push({ x, r: 0 }); list.push({ x, r: 2 }); }
  for (let x = 0; x < W - 1; x++) list.push({ x, r: 1 });
  for (let x = 1; x < W; x++) list.push({ x, r: 3 });
  return list;
}
const ALL_PLACEMENTS = placements();

function inDanger(g, pendingIn) {
  const h = heights(g);
  const total = h.reduce((a, b) => a + b, 0);
  return pendingIn >= 6 || h[SPAWN_X] >= 8 || Math.max(...h) >= 10 || total >= 46;
}

function scoreMove(g0, pl, pair, lvl, ctx) {
  if (!reachable(g0, pl.x, pl.r)) return null;
  const g = g0.slice();
  placePair(g, pl.x, pl.r, pair[0].c, pair[1].c);
  const sim = simulateGrid(g);
  if (g[W + SPAWN_X] >= 0) return { g, v: -1e9, sim };
  if (sim.chain > 0) {
    const garbage = Math.floor(sim.score / 70);
    const fire = sim.chain >= lvl.fireAt || ctx.danger ||
      (ctx.pendingIn > 0 && garbage >= ctx.pendingIn * 0.6) ||
      (ctx.oppPending > 0 && sim.chain >= 2);
    if (fire) return { g, v: 1e5 + sim.score + evaluate(g, lvl, ctx.colors) * 0.1, sim, fire: true };
    return { g, v: evaluate(g, lvl, ctx.colors) - 1500 * sim.chain, sim };
  }
  return { g, v: evaluate(g, lvl, ctx.colors), sim };
}

export function choosePlacement(game, lvl, oppPending = 0) {
  const g0 = toGrid(game.board);
  const pair = [game.pair.a, game.pair.b];
  const ctx = { colors: game.colors, pendingIn: game.pendingIn, oppPending, danger: inDanger(g0, game.pendingIn) };
  const valid = ALL_PLACEMENTS.filter((p) => reachable(g0, p.x, p.r));
  if (!valid.length) return { x: game.pair.x, r: game.pair.r };
  if (Math.random() < lvl.randomMove) return valid[Math.floor(Math.random() * valid.length)];

  let cands = [];
  for (const pl of valid) {
    const res = scoreMove(g0, pl, pair, lvl, ctx);
    if (res) cands.push({ pl, ...res });
  }
  if (lvl.depth >= 2) {
    const next = game.nextPairs[0];
    cands.sort((a, b) => b.v - a.v);
    cands = cands.slice(0, 8);
    for (const c of cands) {
      if (c.fire || c.v <= -1e9) continue;
      let best = -Infinity;
      for (const pl2 of ALL_PLACEMENTS) {
        const res = scoreMove(c.g, pl2, next, lvl, ctx);
        if (res && res.v > best) best = res.v;
      }
      if (best > -Infinity) c.v = Math.max(c.v, best * 0.95);
    }
  }
  let bestC = null;
  for (const c of cands) {
    const v = c.v + (Math.random() - 0.5) * lvl.noise;
    if (!bestC || v > bestC.score) bestC = { score: v, pl: c.pl };
  }
  return bestC ? bestC.pl : valid[0];
}

// 컴퓨터가 실제로 키를 누르듯 조금씩 움직입니다.
export class CpuController {
  constructor(game, levelKey, getOppPending = () => 0) {
    this.game = game;
    this.lvl = LEVELS[levelKey] || LEVELS.normal;
    this.getOppPending = getOppPending;
    this.plan = null;
    this.planFor = -1;
    this.timer = 0;
    this.qTimer = null;
    this.rotateFails = 0;
  }

  update(dt) {
    const g = this.game;
    const lvl = this.lvl;
    if (g.state === 'question') {
      if (this.qTimer === null) this.qTimer = rand(lvl.answerTime);
      this.qTimer -= dt;
      if (this.qTimer <= 0 && g.lockout <= 0) {
        const q = g.question;
        const ok = Math.random() >= lvl.wrongRate;
        const wrong = q.answer + (Math.random() < 0.5 ? -1 : 1) * (q.a > 1 ? q.a : 1);
        g.answer(ok ? q.answer : Math.max(1, wrong));
        this.qTimer = ok ? null : rand(lvl.answerTime) * 0.6;
      }
      return;
    }
    this.qTimer = null;
    if (g.state !== 'fall' || !g.pair) return;
    if (this.planFor !== g.pairIndex) {
      this.plan = choosePlacement(g, lvl, this.getOppPending());
      this.planFor = g.pairIndex;
      this.timer = lvl.think;
      this.rotateFails = 0;
      g.setSoftDrop(false);
    }
    this.timer -= dt;
    if (this.timer > 0) return;
    this.timer = lvl.actionDelay;
    const p = g.pair;
    const plan = this.plan;
    if (p.r !== plan.r) {
      const dir = (plan.r - p.r + 4) % 4 === 3 ? -1 : 1;
      if (!g.rotate(dir) && ++this.rotateFails > 3) plan.r = p.r;
      return;
    }
    if (p.x < plan.x) { if (!g.move(1)) plan.x = p.x; return; }
    if (p.x > plan.x) { if (!g.move(-1)) plan.x = p.x; return; }
    if (lvl.softDrop) g.setSoftDrop(true);
  }
}

function rand([a, b]) { return a + Math.random() * (b - a); }
