// 게임 규칙의 핵심 (보드, 연쇄 판정, 점수, 방해 슬라임 계산)
// 브라우저와 Node(테스트) 양쪽에서 동작하는 순수 로직만 둡니다.

export const W = 6;            // 열 개수
export const H = 13;           // 행 개수 (0번 행은 화면에 보이지 않는 숨은 행)
export const SPAWN_X = 2;      // 슬라임이 나오는 열 (왼쪽에서 3번째)
export const GARBAGE = 9;      // 방해 슬라임 색 번호
export const TARGET_POINTS = 70;      // 방해 슬라임 1개 = 70점
export const ALL_CLEAR_BONUS = 30;    // 전체 클리어 보너스 (방해 슬라임 30개)
export const MAX_GARBAGE_DROP = 30;   // 한 번에 떨어지는 방해 슬라임 최대 개수 (5줄)

// 회전 상태별 자식 슬라임 위치 (0: 위, 1: 오른쪽, 2: 아래, 3: 왼쪽)
export const ROT_OFFSETS = [[0, -1], [1, 0], [0, 1], [-1, 0]];

// 연쇄 보너스 / 색 보너스 / 연결 보너스 (연쇄 퍼즐에서 흔히 쓰는 점수 계산)
export const CHAIN_POWER = [0, 8, 16, 32, 64, 96, 128, 160, 192, 224, 256, 288, 320, 352, 384, 416, 448, 480, 512];
export const COLOR_BONUS = [0, 3, 6, 12, 24];
export function groupBonus(n) {
  if (n <= 4) return 0;
  if (n >= 11) return 10;
  return n - 3; // 5→2, 6→3, ... 10→7
}

// 시드 고정 난수 (모든 플레이어가 같은 순서의 슬라임을 받도록)
export function makeRng(seed) {
  let a = seed >>> 0;
  return function () {
    a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function emptyBoard() {
  return Array.from({ length: H }, () => Array(W).fill(null));
}

export function makeCell(c, n) {
  return { c, n, fall: 0 };
}

// 두 개씩 내려오는 슬라임 순서. 같은 시드면 같은 순서가 나옵니다.
export class PairQueue {
  constructor(seed, colors = 4) {
    this.rng = makeRng(seed);
    this.colors = colors;
    this.list = [];
  }
  get(i) {
    while (this.list.length <= i) this.list.push(this._gen());
    return this.list[i];
  }
  _gen() {
    const r = this.rng;
    // 처음 두 쌍은 3가지 색 안에서만 나옵니다. (시작부터 너무 어렵지 않게)
    const nc = this.list.length < 2 ? Math.min(3, this.colors) : this.colors;
    const mk = () => ({ c: Math.floor(r() * nc), n: 1 + Math.floor(r() * 9) });
    return [mk(), mk()];
  }
}

// 중력 적용: 빈칸 위에 떠 있는 슬라임을 아래로 내립니다.
// 떨어진 거리를 cell.fall 에 기록해 애니메이션에 사용합니다.
export function applyGravity(board) {
  let moved = false;
  for (let x = 0; x < W; x++) {
    let write = H - 1;
    for (let y = H - 1; y >= 0; y--) {
      const cell = board[y][x];
      if (!cell) continue;
      if (y !== write) {
        board[write][x] = cell;
        board[y][x] = null;
        cell.fall = (cell.fall || 0) + (write - y);
        moved = true;
      }
      write--;
    }
  }
  return moved;
}

// 같은 색 4개 이상 연결된 묶음 찾기 (숨은 행 0번은 연결에 포함되지 않음)
export function findGroups(board) {
  const seen = new Uint8Array(W * H);
  const groups = [];
  for (let y = 1; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const cell = board[y][x];
      if (!cell || cell.c === GARBAGE || seen[y * W + x]) continue;
      const color = cell.c;
      const cells = [];
      const stack = [[x, y]];
      seen[y * W + x] = 1;
      while (stack.length) {
        const [cx, cy] = stack.pop();
        cells.push([cx, cy]);
        for (const [dx, dy] of ROT_OFFSETS) {
          const nx = cx + dx, ny = cy + dy;
          if (nx < 0 || nx >= W || ny < 1 || ny >= H) continue;
          if (seen[ny * W + nx]) continue;
          const n = board[ny][nx];
          if (n && n.c === color) {
            seen[ny * W + nx] = 1;
            stack.push([nx, ny]);
          }
        }
      }
      if (cells.length >= 4) groups.push({ c: color, cells });
    }
  }
  return groups;
}

// 묶음과, 그 옆에 붙은 방해 슬라임을 함께 지웁니다.
export function clearGroups(board, groups) {
  let colored = 0, garbage = 0;
  const garbageHits = [];
  for (const g of groups) {
    for (const [x, y] of g.cells) {
      for (const [dx, dy] of ROT_OFFSETS) {
        const nx = x + dx, ny = y + dy;
        if (nx < 0 || nx >= W || ny < 1 || ny >= H) continue;
        const n = board[ny][nx];
        if (n && n.c === GARBAGE) garbageHits.push([nx, ny]);
      }
    }
  }
  for (const g of groups) {
    for (const [x, y] of g.cells) {
      if (board[y][x]) { board[y][x] = null; colored++; }
    }
  }
  for (const [x, y] of garbageHits) {
    if (board[y][x]) { board[y][x] = null; garbage++; }
  }
  return { colored, garbage };
}

// 한 단계(연쇄 1회)의 점수
export function scoreStep(groups, chain) {
  let pc = 0, gb = 0;
  const colors = new Set();
  for (const g of groups) {
    pc += g.cells.length;
    gb += groupBonus(g.cells.length);
    colors.add(g.c);
  }
  const cp = CHAIN_POWER[Math.min(chain, CHAIN_POWER.length) - 1];
  const cb = COLOR_BONUS[colors.size - 1];
  const bonus = Math.min(999, Math.max(1, cp + cb + gb));
  return 10 * pc * bonus;
}

// 점수 → 방해 슬라임 수 (남은 점수는 다음으로 이월)
export function garbageFromScore(score, leftover = 0) {
  const total = score + leftover;
  return { count: Math.floor(total / TARGET_POINTS), leftover: total % TARGET_POINTS };
}

// 방해 슬라임 n개를 열별로 몇 개씩 떨어뜨릴지 정합니다.
export function planGarbageDrop(n, rng = Math.random) {
  const counts = Array(W).fill(Math.floor(n / W));
  const rem = n % W;
  const cols = [0, 1, 2, 3, 4, 5];
  for (let i = cols.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [cols[i], cols[j]] = [cols[j], cols[i]];
  }
  for (let i = 0; i < rem; i++) counts[cols[i]]++;
  return counts;
}

export function isBoardEmpty(board) {
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) if (board[y][x]) return false;
  return true;
}

// 애니메이션 없이 연쇄를 끝까지 계산 (테스트/검증용)
export function resolveAll(board) {
  let chain = 0, score = 0;
  applyGravity(board);
  for (;;) {
    const groups = findGroups(board);
    if (!groups.length) break;
    chain++;
    score += scoreStep(groups, chain);
    clearGroups(board, groups);
    applyGravity(board);
  }
  return { chain, score };
}

// 테스트·디버그용: 문자열 배열로 보드 만들기 (아래쪽 줄이 배열의 끝)
// 'R','G','B','Y','P' = 색, 'X' = 방해, '.' = 빈칸
export function boardFromRows(rows) {
  const map = { R: 0, G: 1, B: 2, Y: 3, P: 4, X: GARBAGE };
  const b = emptyBoard();
  const offset = H - rows.length;
  rows.forEach((row, i) => {
    [...row].forEach((ch, x) => {
      if (ch in map) b[offset + i][x] = makeCell(map[ch], ch === 'X' ? 0 : 5);
    });
  });
  return b;
}
