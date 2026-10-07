// 한 명의 플레이어 게임 진행 (상태 기계)
// spawn → fall → (lock) → drop → check → [question] → pop → drop → check ... → spawn
import {
  W, H, SPAWN_X, GARBAGE, ROT_OFFSETS, ALL_CLEAR_BONUS, MAX_GARBAGE_DROP,
  emptyBoard, makeCell, makeRng, PairQueue, applyGravity, findGroups, clearGroups,
  scoreStep, garbageFromScore, planGarbageDrop, isBoardEmpty,
} from './core.js';

const DROP_SPEED = 16;     // 칸/초, 착지 후 슬라임이 떨어지는 속도
const SOFT_DROP_SPEED = 20;
const LOCK_DELAY = 0.5;    // 바닥에 닿은 뒤 고정까지 시간
const POP_TIME = 0.5;      // 터지는 연출 시간
const WRONG_LOCKOUT = 2.0; // 오답 후 다시 입력할 수 있을 때까지 시간

export class PlayerGame {
  constructor({ seed = 1, colors = 4, name = '', askQuestions = true } = {}) {
    this.name = name;
    this.colors = colors;
    this.board = emptyBoard();
    this.queue = new PairQueue(seed, colors);
    this.garbageRng = makeRng((seed ^ 0x9e3779b9) >>> 0);
    this.askQuestions = askQuestions;
    this.pairIndex = 0;
    this.pair = null;
    this.state = 'ready';
    this.score = 0;
    this.chain = 0;
    this.pendingIn = 0;
    this.leftover = 0;
    this.allClearPending = false;
    this.fallAcc = 0;
    this.groundTime = 0;
    this.softDrop = false;
    this.popTimer = 0;
    this.popGroups = null;
    this.afterDrop = null;
    this.question = null;
    this.lockout = 0;
    this.time = 0;
    this.popups = [];
    this.stats = { questions: 0, correct: 0, wrong: 0, firstTry: 0, maxChain: 0, sent: 0 };
    this.listeners = {};
  }

  on(ev, fn) { (this.listeners[ev] = this.listeners[ev] || []).push(fn); return this; }
  emit(ev, data) { for (const fn of this.listeners[ev] || []) fn(data); }

  start() { if (this.state === 'ready') this.state = 'spawn'; }

  get nextPairs() {
    return [this.queue.get(this.pairIndex), this.queue.get(this.pairIndex + 1)];
  }

  get isDead() { return this.state === 'dead'; }

  // 낙하 속도 (시간이 지날수록 조금씩 빨라짐)
  gravity() { return Math.min(6, 1.4 + Math.floor(this.time / 45) * 0.4); }

  isFree(x, y) {
    if (x < 0 || x >= W || y >= H || y < -1) return false;
    if (y < 0) return true;
    return !this.board[y][x];
  }

  canPlace(x, y, r) {
    const [dx, dy] = ROT_OFFSETS[r];
    return this.isFree(x, y) && this.isFree(x + dx, y + dy);
  }

  pairDrawY() {
    const p = this.pair;
    if (!p || this.state !== 'fall') return p ? p.y : 0;
    return this.canPlace(p.x, p.y + 1, p.r) ? p.y + this.fallAcc : p.y;
  }

  move(dx) {
    const p = this.pair;
    if (this.state !== 'fall' || !p) return false;
    if (this.canPlace(p.x + dx, p.y, p.r)) { p.x += dx; return true; }
    return false;
  }

  // dir: +1 시계 방향, -1 반시계 방향
  rotate(dir) {
    const p = this.pair;
    if (this.state !== 'fall' || !p) return false;
    const nr = (p.r + dir + 4) % 4;
    const apply = (x, y, r) => { p.x = x; p.y = y; p.r = r; return true; };
    if (this.canPlace(p.x, p.y, nr)) return apply(p.x, p.y, nr);
    if (nr === 1 || nr === 3) {
      // 벽이나 슬라임에 막히면 반대쪽으로 한 칸 밀기
      const kx = p.x - ROT_OFFSETS[nr][0];
      if (this.canPlace(kx, p.y, nr)) return apply(kx, p.y, nr);
      // 양쪽이 다 막힌 좁은 곳이면 위아래를 뒤집기 (퀵 턴)
      const qr = (p.r + 2) % 4;
      if (this.canPlace(p.x, p.y, qr)) return apply(p.x, p.y, qr);
      if (this.canPlace(p.x, p.y - 1, qr)) return apply(p.x, p.y - 1, qr);
      return false;
    }
    if (nr === 2 && this.canPlace(p.x, p.y - 1, nr)) return apply(p.x, p.y - 1, nr);
    return false;
  }

  setSoftDrop(on) { this.softDrop = !!on; }

  receiveGarbage(n) { if (n > 0 && !this.isDead) this.pendingIn += n; }

  addPopup(text, kind = 'chain') {
    this.popups.push({ text, kind, t: 0, life: 1.4 });
  }

  update(dt) {
    if (this.state === 'ready' || this.state === 'dead') return;
    this.time += dt;
    for (const p of this.popups) p.t += dt;
    this.popups = this.popups.filter((p) => p.t < p.life);

    switch (this.state) {
      case 'spawn': return this.spawn();
      case 'fall': return this.updateFall(dt);
      case 'drop': return this.updateDrop(dt);
      case 'check': return this.check();
      case 'question':
        this.lockout = Math.max(0, this.lockout - dt);
        return;
      case 'pop':
        this.popTimer -= dt;
        if (this.popTimer <= 0) this.finishPop();
        return;
    }
  }

  spawn() {
    if (this.board[1][SPAWN_X]) {
      this.state = 'dead';
      this.pair = null;
      this.emit('dead');
      return;
    }
    const [a, b] = this.queue.get(this.pairIndex++);
    this.pair = { x: SPAWN_X, y: 1, r: 0, a, b };
    this.fallAcc = 0;
    this.groundTime = 0;
    this.state = 'fall';
    this.emit('spawn');
  }

  updateFall(dt) {
    const p = this.pair;
    if (this.canPlace(p.x, p.y + 1, p.r)) {
      this.fallAcc += (this.softDrop ? SOFT_DROP_SPEED : this.gravity()) * dt;
      while (this.fallAcc >= 1) {
        if (!this.canPlace(p.x, p.y + 1, p.r)) { this.fallAcc = 0; break; }
        p.y++;
        this.fallAcc -= 1;
        if (this.softDrop) this.score += 1;
      }
    } else {
      this.fallAcc = 0;
      this.groundTime += dt;
      if (this.softDrop || this.groundTime >= LOCK_DELAY) this.lockPair();
    }
  }

  lockPair() {
    const p = this.pair;
    const [dx, dy] = ROT_OFFSETS[p.r];
    // 숨은 행보다 위(화면 밖)에 놓인 슬라임은 사라집니다.
    if (p.y >= 0) this.board[p.y][p.x] = makeCell(p.a.c, p.a.n);
    if (p.y + dy >= 0) this.board[p.y + dy][p.x + dx] = makeCell(p.b.c, p.b.n);
    this.pair = null;
    applyGravity(this.board);
    this.state = 'drop';
    this.afterDrop = 'check';
    this.emit('lock');
  }

  updateDrop(dt) {
    let any = false;
    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) {
        const c = this.board[y][x];
        if (c && c.fall > 0) {
          c.fall = Math.max(0, c.fall - DROP_SPEED * dt);
          if (c.fall > 0) any = true;
        }
      }
    }
    if (!any) this.state = this.afterDrop;
  }

  check() {
    const groups = findGroups(this.board);
    if (!groups.length) return this.endChain();
    if (this.chain === 0 && this.askQuestions) return this.makeQuestion(groups);
    this.startPop(groups);
  }

  // 첫 연쇄의 묶음에서 숫자 2개를 골라 곱셈 문제를 냅니다.
  makeQuestion(groups) {
    const g = groups.reduce((a, b) => (b.cells.length > a.cells.length ? b : a));
    const i = Math.floor(Math.random() * g.cells.length);
    let j = Math.floor(Math.random() * (g.cells.length - 1));
    if (j >= i) j++;
    const c1 = g.cells[i], c2 = g.cells[j];
    const a = this.board[c1[1]][c1[0]].n;
    const b = this.board[c2[1]][c2[0]].n;
    for (const gr of groups) for (const [x, y] of gr.cells) this.board[y][x].grp = true;
    this.board[c1[1]][c1[0]].q = true;
    this.board[c2[1]][c2[0]].q = true;
    this.question = { a, b, answer: a * b, groups, tries: 0 };
    this.lockout = 0;
    this.stats.questions++;
    this.state = 'question';
    this.emit('question', this.question);
  }

  // 정답이면 true, 오답이면 false, 지금 입력할 수 없으면 null
  answer(value) {
    if (this.state !== 'question' || this.lockout > 0) return null;
    const q = this.question;
    if (Number(value) === q.answer) {
      this.stats.correct++;
      if (q.tries === 0) this.stats.firstTry++;
      this.question = null;
      this.emit('correct', q);
      this.startPop(q.groups);
      return true;
    }
    q.tries++;
    this.stats.wrong++;
    this.lockout = WRONG_LOCKOUT;
    this.emit('wrong', q);
    return false;
  }

  startPop(groups) {
    this.chain++;
    for (const g of groups) {
      for (const [x, y] of g.cells) {
        const c = this.board[y][x];
        c.pop = true; c.q = false; c.grp = false;
      }
    }
    this.popGroups = groups;
    this.popTimer = POP_TIME;
    this.state = 'pop';
  }

  finishPop() {
    const groups = this.popGroups;
    const step = scoreStep(groups, this.chain);
    this.score += step;
    clearGroups(this.board, groups);
    this.popGroups = null;
    this.stats.maxChain = Math.max(this.stats.maxChain, this.chain);
    this.addPopup(`${this.chain}연쇄!`, 'chain');
    this.emit('chain', { chain: this.chain, score: step });

    let { count, leftover } = garbageFromScore(step, this.leftover);
    this.leftover = leftover;
    if (this.allClearPending) { count += ALL_CLEAR_BONUS; this.allClearPending = false; }
    // 받을 방해 슬라임이 있으면 먼저 상쇄합니다.
    if (this.pendingIn > 0 && count > 0) {
      const m = Math.min(count, this.pendingIn);
      this.pendingIn -= m;
      count -= m;
    }
    if (count > 0) {
      this.stats.sent += count;
      this.emit('attack', count);
    }

    applyGravity(this.board);
    this.state = 'drop';
    this.afterDrop = 'check';
  }

  endChain() {
    if (this.chain > 0) {
      if (isBoardEmpty(this.board)) {
        this.allClearPending = true;
        this.addPopup('전체 클리어!', 'allclear');
        this.emit('allclear');
      }
      this.emit('chainEnd', this.chain);
      this.chain = 0;
    }
    if (this.pendingIn > 0) {
      this.dropGarbage();
      this.state = 'drop';
      this.afterDrop = 'spawn';
    } else {
      this.state = 'spawn';
    }
  }

  dropGarbage() {
    const n = Math.min(this.pendingIn, MAX_GARBAGE_DROP);
    this.pendingIn -= n;
    const counts = planGarbageDrop(n, this.garbageRng);
    for (let x = 0; x < W; x++) {
      let y = H - 1;
      while (y >= 0 && this.board[y][x]) y--;
      for (let k = 0; k < counts[x] && y >= 0; k++, y--) {
        const cell = makeCell(GARBAGE, 0);
        cell.fall = y + 1 + k;
        this.board[y][x] = cell;
      }
    }
    this.emit('garbage', n);
  }

  // 온라인 상대에게 보내는 화면 정보
  snapshot() {
    let b = '';
    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) {
        const c = this.board[y][x];
        b += c ? (c.c === GARBAGE ? 'g0' : `${c.c}${c.n}`) : '..';
      }
    }
    const p = this.pair;
    const [n1, n2] = this.nextPairs;
    return {
      b,
      p: p ? [p.x, p.y, p.r, p.a.c, p.a.n, p.b.c, p.b.n] : null,
      nx: [n1[0].c, n1[0].n, n1[1].c, n1[1].n, n2[0].c, n2[0].n, n2[1].c, n2[1].n],
      s: this.score,
      pi: this.pendingIn,
      st: this.state,
      ch: this.chain,
      q: this.question ? [this.question.a, this.question.b] : null,
    };
  }
}

// 온라인 상대 화면 (스냅샷을 받아 그리기만 함)
export class RemoteView {
  constructor(name) {
    this.name = name;
    this.board = emptyBoard();
    this.pair = null;
    this.nextPairs = null;
    this.score = 0;
    this.pendingIn = 0;
    this.state = 'ready';
    this.chain = 0;
    this.question = null;
    this.popups = [];
    this.time = 0;
  }

  get isDead() { return this.state === 'dead'; }

  pairDrawY() { return this.pair ? this.pair.y : 0; }

  apply(s) {
    if (!s || typeof s.b !== 'string' || s.b.length !== W * H * 2) return;
    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) {
        const i = (y * W + x) * 2;
        const ch = s.b[i];
        if (ch === '.') { this.board[y][x] = null; continue; }
        const c = ch === 'g' ? GARBAGE : Number(ch);
        const cell = makeCell(c, Number(s.b[i + 1]));
        this.board[y][x] = cell;
      }
    }
    // 터지는 중이면 실제로 연결된 묶음만 깜빡이게 표시
    if (s.st === 'pop') {
      const groups = findGroups(this.board);
      for (const g of groups) for (const [x, y] of g.cells) this.board[y][x].pop = true;
    }
    if (s.st === 'question') {
      for (const g of findGroups(this.board)) for (const [x, y] of g.cells) this.board[y][x].grp = true;
    }
    const p = s.p;
    this.pair = p ? { x: p[0], y: p[1], r: p[2], a: { c: p[3], n: p[4] }, b: { c: p[5], n: p[6] } } : null;
    const n = s.nx || [];
    if (n.length === 8) {
      this.nextPairs = [
        [{ c: n[0], n: n[1] }, { c: n[2], n: n[3] }],
        [{ c: n[4], n: n[5] }, { c: n[6], n: n[7] }],
      ];
    }
    if (s.ch > this.chain && s.ch > 0) this.popups.push({ text: `${s.ch}연쇄!`, kind: 'chain', t: 0, life: 1.4 });
    this.chain = s.ch | 0;
    this.score = s.s | 0;
    this.pendingIn = s.pi | 0;
    this.state = s.st;
    this.question = s.q ? { a: s.q[0], b: s.q[1] } : null;
  }

  update(dt) {
    this.time += dt;
    for (const p of this.popups) p.t += dt;
    this.popups = this.popups.filter((p) => p.t < p.life);
  }
}
