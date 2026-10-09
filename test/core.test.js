import test from 'node:test';
import assert from 'node:assert/strict';
import {
  W, H, GARBAGE, boardFromRows, findGroups, resolveAll, scoreStep, garbageFromScore,
  planGarbageDrop, PairQueue, emptyBoard, makeCell,
} from '../public/js/core.js';
import { PlayerGame } from '../public/js/player.js';
import { toGrid, simulateGrid, choosePlacement, LEVELS, CpuController } from '../public/js/ai.js';

test('같은 색 4개가 붙으면 묶음으로 찾는다', () => {
  const b = boardFromRows([
    'R.....',
    'RR....',
    'RB....',
  ]);
  const groups = findGroups(b);
  assert.equal(groups.length, 1);
  assert.equal(groups[0].cells.length, 4);
});

test('3개는 터지지 않고, 숨은 행은 연결에 포함되지 않는다', () => {
  const b = boardFromRows(['RRR...']);
  assert.equal(findGroups(b).length, 0);
  const b2 = emptyBoard();
  b2[0][0] = makeCell(0, 1);
  b2[1][0] = makeCell(0, 1);
  b2[2][0] = makeCell(0, 1);
  b2[3][0] = makeCell(0, 1);
  b2[4][0] = makeCell(1, 1);
  for (let y = 5; y < H; y++) b2[y][0] = makeCell(2 + (y % 2), 1);
  assert.equal(findGroups(b2).length, 0);
});

test('2연쇄 계산과 점수', () => {
  const b = boardFromRows([
    'B.....',
    'RBBB..',
    'RRR...',
  ]);
  const r = resolveAll(b);
  assert.equal(r.chain, 2);
  // 1연쇄: 4개 * 10 * 1 = 40, 2연쇄: 4개 * 10 * 8 = 320
  assert.equal(r.score, 360);
});

test('묶음 옆의 방해 슬라임도 같이 사라진다', () => {
  const b = boardFromRows([
    'X.....',
    'RRRRX.',
  ]);
  resolveAll(b);
  let left = 0;
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) if (b[y][x]) left++;
  assert.equal(left, 0);
});

test('점수 보너스: 색 보너스와 연결 보너스', () => {
  const groups = [
    { c: 0, cells: Array(5).fill([0, 0]) },
    { c: 1, cells: Array(4).fill([0, 0]) },
  ];
  // 9개 * 10 * (0 + 3 + 2) = 450
  assert.equal(scoreStep(groups, 1), 450);
});

test('방해 슬라임 수는 70점마다 1개, 남은 점수는 이월', () => {
  assert.deepEqual(garbageFromScore(360, 0), { count: 5, leftover: 10 });
  assert.deepEqual(garbageFromScore(60, 10), { count: 1, leftover: 0 });
});

test('방해 슬라임 분배 합계가 맞다', () => {
  for (const n of [1, 5, 6, 13, 30]) {
    const counts = planGarbageDrop(n);
    assert.equal(counts.reduce((a, b) => a + b, 0), n);
    assert.ok(Math.max(...counts) - Math.min(...counts) <= 1);
  }
});

test('같은 시드면 같은 슬라임 순서', () => {
  const a = new PairQueue(1234), b = new PairQueue(1234);
  for (let i = 0; i < 50; i++) assert.deepEqual(a.get(i), b.get(i));
  for (let i = 0; i < 50; i++) for (const p of a.get(i)) assert.ok(p.n >= 1 && p.n <= 9);
});

test('AI 시뮬레이션이 일반 계산과 같은 결과를 낸다', () => {
  const rows = ['B.....', 'RBBB..', 'RRR...'];
  const g = toGrid(boardFromRows(rows));
  assert.deepEqual(simulateGrid(g), resolveAll(boardFromRows(rows)));
});

function runUntil(game, cond, maxSteps = 5000) {
  for (let i = 0; i < maxSteps && !cond(); i++) game.update(1 / 60);
}

test('첫 연쇄 전에 곱셈 문제가 나오고, 정답이면 연쇄가 문제 없이 이어진다', () => {
  const g = new PlayerGame({ seed: 1 });
  g.board = boardFromRows([
    'B.....',
    'RBBB..',
    'RRR...',
  ]);
  g.state = 'check';
  let questions = 0, attacks = 0;
  g.on('question', () => questions++);
  g.on('attack', (n) => { attacks += n; });
  g.update(0.016);
  assert.equal(g.state, 'question');
  const q = g.question;
  assert.ok(q.a >= 1 && q.a <= 9 && q.b >= 1 && q.b <= 9);
  assert.equal(q.answer, q.a * q.b);

  // 오답: 잠깐 입력 불가
  assert.equal(g.answer(q.answer + 1), false);
  assert.equal(g.answer(q.answer), null);
  runUntil(g, () => g.lockout === 0);
  assert.equal(g.answer(q.answer), true);

  runUntil(g, () => g.state === 'spawn' || g.state === 'fall');
  assert.equal(questions, 1, '연쇄 중에는 문제를 다시 내지 않는다');
  assert.equal(g.stats.maxChain, 2);
  assert.equal(g.score, 360);
  assert.equal(attacks, 5);
});

test('받은 방해 슬라임은 연쇄로 상쇄되고, 남으면 떨어진다', () => {
  const g = new PlayerGame({ seed: 1, askQuestions: false });
  g.board = boardFromRows(['RRRR..']);
  g.receiveGarbage(10);
  g.state = 'check';
  runUntil(g, () => g.state === 'fall');
  // 40점 → 0개 (이월 40), 상쇄 없음 → 10개가 떨어짐
  let garbage = 0;
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) if (g.board[y][x]?.c === GARBAGE) garbage++;
  assert.equal(garbage, 10);
  assert.equal(g.pendingIn, 0);
});

test('X 칸이 막히면 게임 오버', () => {
  const g = new PlayerGame({ seed: 1 });
  for (let y = 1; y < H; y++) g.board[y][2] = makeCell(GARBAGE, 0);
  let dead = false;
  g.on('dead', () => { dead = true; });
  g.start();
  g.update(0.016);
  assert.ok(dead);
});

test('회전: 벽에 붙어 있으면 반대쪽으로 밀린다', () => {
  const g = new PlayerGame({ seed: 1 });
  g.start();
  g.update(0.016);
  while (g.move(1));
  assert.equal(g.pair.x, 5);
  assert.ok(g.rotate(1));
  assert.equal(g.pair.r, 1);
  assert.equal(g.pair.x, 4);
});

for (const lv of Object.keys(LEVELS)) {
  test(`컴퓨터(${LEVELS[lv].name})가 혼자 한동안 버틸 수 있다`, () => {
    const origRandom = Math.random;
    let s = 42;
    Math.random = () => { s = (s * 16807) % 2147483647; return s / 2147483647; };
    try {
      const g = new PlayerGame({ seed: 7 });
      const ctrl = new CpuController(g, lv);
      g.start();
      let pieces = 0;
      g.on('spawn', () => pieces++);
      for (let i = 0; i < 60 * 240 && !g.isDead && pieces < 60; i++) {
        ctrl.update(1 / 60);
        g.update(1 / 60);
      }
      assert.ok(pieces >= (lv === 'easy' ? 15 : 40), `${pieces}개 놓음, 죽음=${g.isDead}`);
      if (lv === 'hard') assert.ok(g.stats.maxChain >= 2, `최대 연쇄 ${g.stats.maxChain}`);
    } finally {
      Math.random = origRandom;
    }
  });
}

test('choosePlacement 는 놓을 수 있는 위치를 고른다', () => {
  const g = new PlayerGame({ seed: 3 });
  g.start();
  g.update(0.016);
  const pl = choosePlacement(g, LEVELS.hard);
  assert.ok(pl.x >= 0 && pl.x < W && pl.r >= 0 && pl.r < 4);
});

test('연쇄 가이드: 2연쇄가 되는 자리를 찾음', async () => {
  const { chainHint } = await import('../public/js/ai.js');
  const { emptyBoard, makeCell } = await import('../public/js/core.js');
  const b = emptyBoard();
  const put = (x, y, c) => { b[y][x] = makeCell(c, 1); };
  // 맨 아래 왼쪽: 빨강(0) 3개 위에 파랑(1) 3개 → 빨강 하나를 더하면 빨강이 터지고 파랑이 내려와 2연쇄 준비
  // 0열: 아래부터 0,0,0 / 1열: 1,1,1 위에 아무것도 → 빨강+파랑 쌍을 세우면?
  put(0, 12, 0); put(1, 12, 0); put(2, 12, 0);
  put(0, 11, 1); put(1, 11, 1); put(2, 11, 1);
  const pair = { a: { c: 0, n: 2 }, b: { c: 1, n: 3 } };
  const h = chainHint(b, pair);
  assert.ok(h, '자리를 찾아야 함');
  assert.ok(h.chain >= 2, String(h.chain));
  assert.equal(h.cells.length, 2);
  // 연쇄가 안 되는 판에서는 null
  assert.equal(chainHint(emptyBoard(), pair), null);
});

test('구구팡 타임: 보내는 방해 슬라임 1.5배, 터진 자리는 연출로 기록', async () => {
  const { PlayerGame } = await import('../public/js/player.js');
  const { findGroups, makeCell } = await import('../public/js/core.js');
  const sent = (rate) => {
    const g = new PlayerGame({ seed: 1 });
    g.garbageRate = rate;
    for (const [x, y] of [[0, 12], [1, 12], [2, 12], [3, 12]]) g.board[y][x] = makeCell(0, 1);
    let n = 0;
    g.on('attack', (k) => { n += k; });
    g.chain = 1; // 2연쇄째 (연쇄 보너스 8)
    g.startPop(findGroups(g.board));
    g.finishPop();
    return { n, g };
  };
  const normal = sent(1), ggp = sent(1.5);
  assert.equal(normal.n, 4); // 10 × 4개 × 8 = 320점 → 70점마다 1개
  assert.equal(ggp.n, 6);    // 480점 → 6개
  // 연출: 터진 4칸과 2연쇄가 기록되고, 연쇄 글자는 터진 자리 근처에
  const e = normal.g.fxEvents[0];
  assert.equal(e.chain, 2);
  assert.equal(e.cells.length, 4);
  const pop = normal.g.popups.find((p) => p.kind === 'chain');
  assert.equal(pop.text, '2연쇄!');
  assert.ok(Math.abs(pop.gx - 2) < 1e-9 && Math.abs(pop.gy - 12.5) < 1e-9, `${pop.gx},${pop.gy}`);
});
