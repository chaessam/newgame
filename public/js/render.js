// 캔버스 그리기: 젤리 슬라임, 보드, 다음 슬라임, 방해 슬라임 예고
import { W, H, GARBAGE, SPAWN_X, ROT_OFFSETS } from './core.js';

export const COLORS = [
  { main: '#ff5d73', light: '#ffc2cb', dark: '#c22f4a' }, // 빨강
  { main: '#34c47a', light: '#a6f0c6', dark: '#1d8a50' }, // 초록
  { main: '#4a8cff', light: '#b3cfff', dark: '#285fc9' }, // 파랑
  { main: '#ffbf2e', light: '#ffe6a0', dark: '#c98a00' }, // 노랑
  { main: '#a86cff', light: '#dcc4ff', dark: '#7440cc' }, // 보라
];
const GARBAGE_COLOR = { main: '#aab3c2', light: '#e1e6ee', dark: '#6c7687' };
const FONT = '"Jua", "Apple SD Gothic Neo", "Malgun Gothic", sans-serif';

const dpr = () => Math.min(window.devicePixelRatio || 1, 2);
const spriteCache = new Map();

function roundRect(ctx, x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

// 젤리 몸통 스프라이트 (색·크기별로 한 번만 그려서 재사용)
function bodySprite(c, cs) {
  const key = `${c}:${cs}:${dpr()}`;
  let cv = spriteCache.get(key);
  if (cv) return cv;
  const s = dpr();
  cv = document.createElement('canvas');
  cv.width = Math.ceil(cs * s);
  cv.height = Math.ceil(cs * s);
  const ctx = cv.getContext('2d');
  ctx.scale(s, s);
  const col = c === GARBAGE ? GARBAGE_COLOR : COLORS[c];
  const m = cs * 0.06;
  const size = cs - m * 2;
  const grad = ctx.createLinearGradient(0, m, 0, cs - m);
  grad.addColorStop(0, col.light);
  grad.addColorStop(0.45, col.main);
  grad.addColorStop(1, col.dark);
  roundRect(ctx, m, m, size, size, cs * 0.32);
  ctx.fillStyle = grad;
  ctx.fill();
  ctx.lineWidth = Math.max(1, cs * 0.05);
  ctx.strokeStyle = col.dark;
  ctx.stroke();
  // 반짝이는 부분
  ctx.fillStyle = 'rgba(255,255,255,0.55)';
  ctx.beginPath();
  ctx.ellipse(cs * 0.32, cs * 0.24, cs * 0.14, cs * 0.07, -0.5, 0, Math.PI * 2);
  ctx.fill();
  if (c === GARBAGE) {
    // 방해 슬라임: 졸린 눈
    ctx.strokeStyle = col.dark;
    ctx.lineWidth = Math.max(1.5, cs * 0.06);
    ctx.lineCap = 'round';
    for (const ex of [0.36, 0.64]) {
      ctx.beginPath();
      ctx.moveTo(cs * (ex - 0.08), cs * 0.52);
      ctx.lineTo(cs * (ex + 0.08), cs * 0.52);
      ctx.stroke();
    }
    ctx.beginPath();
    ctx.arc(cs * 0.5, cs * 0.72, cs * 0.06, 0, Math.PI, true);
    ctx.stroke();
  } else {
    // 작은 눈
    ctx.fillStyle = 'rgba(30,30,50,0.85)';
    for (const ex of [0.66, 0.8]) {
      ctx.beginPath();
      ctx.arc(cs * ex, cs * 0.24, cs * 0.04, 0, Math.PI * 2);
      ctx.fill();
    }
  }
  spriteCache.set(key, cv);
  return cv;
}

export function drawSlime(ctx, px, py, cs, cell, opts = {}) {
  const { c, n } = cell;
  ctx.save();
  let scale = opts.scale || 1;
  if (cell.pop) {
    const t = opts.time || 0;
    ctx.globalAlpha = 0.45 + 0.55 * Math.abs(Math.sin(t * 18));
    scale *= 1.08;
  }
  if (scale !== 1) {
    ctx.translate(px + cs / 2, py + cs / 2);
    ctx.scale(scale, scale);
    ctx.translate(-px - cs / 2, -py - cs / 2);
  }
  ctx.drawImage(bodySprite(c, cs), px, py, cs, cs);
  if (c !== GARBAGE && n) {
    const col = COLORS[c];
    ctx.font = `${Math.round(cs * 0.56)}px ${FONT}`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.lineJoin = 'round';
    ctx.lineWidth = Math.max(2, cs * 0.12);
    ctx.strokeStyle = col.dark;
    ctx.strokeText(String(n), px + cs * 0.5, py + cs * 0.58);
    ctx.fillStyle = '#fff';
    ctx.fillText(String(n), px + cs * 0.5, py + cs * 0.58);
  }
  ctx.restore();
}

// 보드 배경의 별과 아래쪽 네온 격자 (보드마다 같은 모양이 나오도록 고정된 난수 사용)
function drawStars(ctx, w, h, cs) {
  let seed = 7;
  const r = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
  for (let i = 0; i < 40; i++) {
    ctx.fillStyle = `rgba(255,255,255,${0.12 + r() * 0.45})`;
    ctx.fillRect(r() * w, r() * h, 1.6, 1.6);
  }
  ctx.strokeStyle = 'rgba(122, 92, 255, 0.16)';
  ctx.lineWidth = 1;
  for (let y = h; y > h * 0.55; y -= cs * 0.6) {
    ctx.beginPath(); ctx.moveTo(0, y + 0.5); ctx.lineTo(w, y + 0.5); ctx.stroke();
  }
}

// 게임 오버 칸(왼쪽에서 세 번째 줄 맨 위) 경고.
// 평소에는 아무것도 그리지 않고, 그 줄이 거의 다 찼을 때만 빨갛게 깜빡이며 알려 줍니다.
function drawDanger(ctx, board, cs, pad, t) {
  let top = 0; // 그 줄에서 가장 위에 있는 슬라임의 행 (0이면 비어 있음)
  for (let y = 1; y < board.length; y++) if (board[y][SPAWN_X]) { top = y; break; }
  if (!top || top > 4) return;
  const level = top <= 2 ? 1 : 0.6; // 한 칸 남았으면 더 강하게
  const pulse = 0.5 + 0.5 * Math.sin(t * (top <= 2 ? 12 : 7));
  const x = SPAWN_X * cs, y = pad;
  ctx.save();
  const g = ctx.createLinearGradient(0, y, 0, y + cs * 1.6);
  g.addColorStop(0, `rgba(255, 60, 90, ${(0.35 + 0.35 * pulse) * level})`);
  g.addColorStop(1, 'rgba(255, 60, 90, 0)');
  ctx.fillStyle = g;
  ctx.fillRect(x, 0, cs, y + cs * 1.6);
  ctx.strokeStyle = `rgba(255, 90, 120, ${(0.55 + 0.45 * pulse) * level})`;
  ctx.lineWidth = cs * 0.08;
  ctx.shadowColor = 'rgba(255, 60, 90, 0.9)';
  ctx.shadowBlur = cs * 0.4 * pulse;
  roundRect(ctx, x + cs * 0.08, y + cs * 0.08, cs * 0.84, cs * 0.84, cs * 0.25);
  ctx.stroke();
  ctx.shadowBlur = 0;
  ctx.font = `${Math.round(cs * 0.62)}px ${FONT}`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillStyle = `rgba(255, 235, 240, ${0.6 + 0.4 * pulse})`;
  ctx.fillText('!', x + cs / 2, y + cs * 0.52);
  ctx.restore();
}

// 보드 캔버스 크기를 맞춥니다.
export function sizeCanvas(canvas, w, h) {
  const s = dpr();
  if (canvas.width !== Math.round(w * s) || canvas.height !== Math.round(h * s)) {
    canvas.width = Math.round(w * s);
    canvas.height = Math.round(h * s);
  }
  canvas.style.width = `${w}px`;
  canvas.style.height = `${h}px`;
  const ctx = canvas.getContext('2d');
  ctx.setTransform(s, 0, 0, s, 0, 0);
  return ctx;
}

export function drawBoard(canvas, view, cs) {
  const pad = Math.round(cs * 0.5); // 숨은 행을 반쯤 보여 줌
  const bw = W * cs, bh = (H - 1) * cs + pad;
  const ctx = sizeCanvas(canvas, bw, bh);
  const t = view.time || 0;
  ctx.clearRect(0, 0, bw, bh);

  // 배경
  const bg = ctx.createLinearGradient(0, 0, 0, bh);
  bg.addColorStop(0, '#1a0b45');
  bg.addColorStop(1, '#07031a');
  ctx.fillStyle = bg;
  ctx.fillRect(0, 0, bw, bh);
  drawStars(ctx, bw, bh, cs);
  ctx.fillStyle = 'rgba(0,0,0,0.25)';
  ctx.fillRect(0, 0, bw, pad);
  ctx.strokeStyle = 'rgba(122, 92, 255, 0.12)';
  ctx.lineWidth = 1;
  for (let x = 1; x < W; x++) {
    ctx.beginPath(); ctx.moveTo(x * cs + 0.5, 0); ctx.lineTo(x * cs + 0.5, bh); ctx.stroke();
  }

  const rowY = (y) => (y - 1) * cs + pad;
  const b = view.board;

  // 같은 색끼리 이어진 부분 (말랑하게 붙어 보이도록)
  for (let y = 1; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const c = b[y][x];
      if (!c || c.c === GARBAGE || c.fall > 0) continue;
      const col = COLORS[c.c].main;
      const r = x + 1 < W ? b[y][x + 1] : null;
      const d = y + 1 < H ? b[y + 1][x] : null;
      ctx.fillStyle = col;
      if (r && r.c === c.c && !(r.fall > 0)) ctx.fillRect(x * cs + cs * 0.5, rowY(y) + cs * 0.22, cs, cs * 0.56);
      if (d && d.c === c.c && !(d.fall > 0)) ctx.fillRect(x * cs + cs * 0.22, rowY(y) + cs * 0.5, cs * 0.56, cs);
    }
  }

  // 놓인 슬라임
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const c = b[y][x];
      if (!c) continue;
      const py = rowY(y - (c.fall || 0));
      if (py <= -cs) continue;
      drawSlime(ctx, x * cs, py, cs, c, { time: t });
      if (c.q || c.grp) {
        ctx.save();
        const pulse = 0.5 + 0.5 * Math.sin(t * 8);
        ctx.strokeStyle = c.q ? `rgba(255,255,255,${0.7 + 0.3 * pulse})` : 'rgba(255,255,255,0.35)';
        ctx.lineWidth = c.q ? cs * 0.12 : cs * 0.05;
        roundRect(ctx, x * cs + cs * 0.04, py + cs * 0.04, cs * 0.92, cs * 0.92, cs * 0.32);
        ctx.stroke();
        ctx.restore();
      }
    }
  }

  // 떨어지는 두 개짜리
  const p = view.pair;
  if (p && view.state === 'fall') {
    const dy = view.pairDrawY();
    const [ox, oy] = ROT_OFFSETS[p.r];
    drawSlime(ctx, (p.x + ox) * cs, rowY(dy + oy), cs, p.b);
    drawSlime(ctx, p.x * cs, rowY(dy), cs, p.a);
    // 축 슬라임 표시
    ctx.save();
    ctx.strokeStyle = 'rgba(255,255,255,0.9)';
    ctx.lineWidth = cs * 0.06;
    roundRect(ctx, p.x * cs + cs * 0.06, rowY(dy) + cs * 0.06, cs * 0.88, cs * 0.88, cs * 0.3);
    ctx.stroke();
    ctx.restore();
  }

  drawDanger(ctx, view.board, cs, pad, t);

  // 연쇄 글자
  for (const pop of view.popups || []) {
    const k = pop.t / pop.life;
    ctx.save();
    ctx.globalAlpha = Math.max(0, 1 - k * k);
    ctx.font = `${Math.round(cs * (pop.kind === 'allclear' ? 0.8 : 1.05))}px ${FONT}`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.lineJoin = 'round';
    ctx.lineWidth = cs * 0.18;
    ctx.strokeStyle = '#3a1d6e';
    const ty = bh * 0.42 - k * cs * 1.2;
    ctx.strokeText(pop.text, bw / 2, ty);
    ctx.fillStyle = pop.kind === 'allclear' ? '#7ff3ff' : '#ffe14d';
    ctx.fillText(pop.text, bw / 2, ty);
    ctx.restore();
  }

  if (view.isDead) {
    ctx.fillStyle = 'rgba(10,10,30,0.6)';
    ctx.fillRect(0, 0, bw, bh);
    ctx.font = `${Math.round(cs * 0.9)}px ${FONT}`;
    ctx.textAlign = 'center';
    ctx.fillStyle = '#fff';
    ctx.fillText('끝!', bw / 2, bh / 2);
  }
}

// 다음 슬라임 한 쌍을 세로로 (위: 자식, 아래: 축)
export function drawNextPair(canvas, pair, cs) {
  const ctx = sizeCanvas(canvas, cs, cs * 2);
  ctx.clearRect(0, 0, cs, cs * 2);
  if (!pair) return;
  drawSlime(ctx, 0, 0, cs, pair[1]);
  drawSlime(ctx, 0, cs, cs, pair[0]);
}

// 받을 예정인 방해 슬라임 표시 (1개=작은 공, 6개=큰 공, 30개=바위, 180개=별)
const UNITS = [[180, 'star'], [30, 'rock'], [6, 'big'], [1, 'small']];
export function drawPending(canvas, n, cs) {
  const w = W * cs, h = cs * 0.7;
  const ctx = sizeCanvas(canvas, w, h);
  ctx.clearRect(0, 0, w, h);
  let left = n, x = cs * 0.1;
  const icons = [];
  for (const [u, kind] of UNITS) {
    while (left >= u && icons.length < 6) { icons.push(kind); left -= u; }
  }
  for (const kind of icons) {
    const cy = h / 2;
    ctx.save();
    if (kind === 'small') {
      ctx.fillStyle = GARBAGE_COLOR.main;
      ctx.beginPath(); ctx.arc(x + cs * 0.2, cy, cs * 0.17, 0, Math.PI * 2); ctx.fill();
      x += cs * 0.48;
    } else if (kind === 'big') {
      ctx.fillStyle = GARBAGE_COLOR.dark;
      ctx.beginPath(); ctx.arc(x + cs * 0.3, cy, cs * 0.28, 0, Math.PI * 2); ctx.fill();
      x += cs * 0.7;
    } else if (kind === 'rock') {
      ctx.fillStyle = '#8a6cc4';
      roundRect(ctx, x, cy - cs * 0.3, cs * 0.6, cs * 0.6, cs * 0.12); ctx.fill();
      x += cs * 0.75;
    } else {
      ctx.fillStyle = '#ffd23f';
      ctx.beginPath();
      for (let i = 0; i < 10; i++) {
        const a = -Math.PI / 2 + (i * Math.PI) / 5;
        const r = i % 2 ? cs * 0.14 : cs * 0.32;
        ctx.lineTo(x + cs * 0.33 + Math.cos(a) * r, cy + Math.sin(a) * r);
      }
      ctx.fill();
      x += cs * 0.75;
    }
    ctx.restore();
  }
  if (n > 0) {
    ctx.font = `${Math.round(cs * 0.4)}px ${FONT}`;
    ctx.textAlign = 'right';
    ctx.textBaseline = 'middle';
    ctx.fillStyle = '#ffd6f6';
    ctx.fillText(`${n}`, w - 4, h / 2);
  }
}

// 메뉴 화면 꾸미기용
export function drawDemoSlime(canvas, c, n, cs) {
  const ctx = sizeCanvas(canvas, cs, cs);
  ctx.clearRect(0, 0, cs, cs);
  drawSlime(ctx, 0, 0, cs, { c, n });
}
