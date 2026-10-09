// 네온 연쇄 연출 (캔버스)
// - 터진 슬라임 자리에서 튀는 불꽃 입자, 칸마다 퍼지는 네온 테두리, 충격파 고리
// - 판 격자가 연쇄 색으로 번쩍, 4연쇄부터 빛기둥
// - 연쇄 글자는 네온 간판처럼 깜빡이며 켜짐 (한 번 그려 둔 그림을 다시 써서 오래된 태블릿에서도 가볍게)
// 게임(PlayerGame/RemoteView)은 view.fxEvents 에 { cells: [[x, y, 색]], chain, delay } 만 넣고,
// 여기서 그리는 순간에 꺼내어 효과로 바꿉니다. 좌표는 모두 칸 단위(판 크기가 바뀌어도 그대로).

const FONT = '"Jua", "Apple SD Gothic Neo", "Malgun Gothic", sans-serif';
const DIGITS = '"Orbitron", "Jua", sans-serif';
const dpr = () => Math.min(window.devicePixelRatio || 1, 2);
const MAX_PARTS = 260;

// 연쇄 단계별 네온 색: 하늘 → 초록 → 분홍 → 보라 → 노랑 → (6연쇄부터 무지개)
const CHAIN_NEON = ['#4ff0ff', '#4ff0ff', '#5cffa1', '#ff4fd8', '#b06bff', '#ffe45c', '#ff6a8a'];
export function chainColor(n) {
  return CHAIN_NEON[Math.max(0, Math.min(n, CHAIN_NEON.length - 1))];
}

function rgba(hex, a) {
  const n = parseInt(hex.slice(1), 16);
  return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${a})`;
}

// 빛 점 그림 (가운데 하얗게 빛나고 바깥으로 색이 번짐) — 색마다 한 번만 만듦
const glowCache = new Map();
function glowSprite(color) {
  let cv = glowCache.get(color);
  if (cv) return cv;
  const S = 64;
  cv = document.createElement('canvas');
  cv.width = S;
  cv.height = S;
  const g = cv.getContext('2d');
  const gr = g.createRadialGradient(S / 2, S / 2, 0, S / 2, S / 2, S / 2);
  gr.addColorStop(0, 'rgba(255,255,255,1)');
  gr.addColorStop(0.16, rgba(color, 1));
  gr.addColorStop(0.42, rgba(color, 0.35));
  gr.addColorStop(1, rgba(color, 0));
  g.fillStyle = gr;
  g.fillRect(0, 0, S, S);
  glowCache.set(color, cv);
  return cv;
}

function fxState(view) {
  if (!view._fx) {
    view._fx = { parts: [], boxes: [], rings: [], beams: [], flashes: [], pending: [], grid: 0, gridColor: '#4ff0ff', last: view.time || 0 };
  }
  return view._fx;
}

function rand(a, b) { return a + Math.random() * (b - a); }

// 터짐 하나를 효과로 바꿈
function spawn(fx, e, colorOf) {
  const n = e.chain || 1;
  const col = chainColor(n);
  const cells = e.cells || [];
  if (!cells.length) return;
  const perCell = Math.max(4, Math.min(6 + n * 2, Math.floor(200 / cells.length)));
  let sx = 0, sy = 0;
  const cols = new Set();
  for (const [x, y, c] of cells) {
    const cx = x + 0.5, cy = y + 0.5;
    sx += cx; sy += cy;
    cols.add(x);
    const pc = colorOf(c);
    fx.boxes.push({ x: cx, y: cy, color: pc, age: 0, life: 0.32 });
    for (let i = 0; i < perCell && fx.parts.length < MAX_PARTS; i++) {
      const a = Math.random() * Math.PI * 2;
      const sp = rand(2.2, 6.5) * (1 + Math.min(n, 6) * 0.07);
      fx.parts.push({
        x: cx + Math.cos(a) * 0.15,
        y: cy + Math.sin(a) * 0.15,
        vx: Math.cos(a) * sp,
        vy: Math.sin(a) * sp - rand(0.5, 2),
        age: 0,
        life: rand(0.4, 0.85),
        size: rand(0.1, 0.24),
        // 대부분 슬라임 색, 일부는 연쇄 색 불꽃
        color: Math.random() < 0.3 ? col : pc,
      });
    }
  }
  const gx = sx / cells.length, gy = sy / cells.length;
  fx.rings.push({ x: gx, y: gy, color: col, age: 0, life: 0.5, r0: 0.35, r1: 1.5 + Math.min(n, 7) * 0.35, w: 0.34 });
  if (n >= 3) fx.rings.push({ x: gx, y: gy, color: '#ffffff', age: -0.07, life: 0.45, r0: 0.2, r1: 1.1 + Math.min(n, 7) * 0.3, w: 0.18 });
  if (n >= 5) fx.rings.push({ x: gx, y: gy, color: chainColor(n + 1), age: -0.14, life: 0.55, r0: 0.3, r1: 2.4 + n * 0.3, w: 0.26 });
  if (n >= 4) for (const x of cols) fx.beams.push({ x: x + 0.5, color: col, age: 0, life: 0.6 });
  fx.grid = Math.max(fx.grid, n >= 2 ? 1 : 0.5);
  fx.gridColor = col;
  fx.flashes.push({ x: gx, y: gy, color: col, age: 0, life: n >= 2 ? 0.4 : 0.22, power: Math.min(0.12 + n * 0.07, 0.5) });
}

function stepList(list, dt) {
  let w = 0;
  for (let i = 0; i < list.length; i++) {
    const o = list[i];
    o.age += dt;
    if (o.age < o.life) list[w++] = o;
  }
  list.length = w;
}

// 시간 흐르기 + 새 터짐 꺼내기 (그리기 직전에 부름)
export function updateFx(view, colorOf) {
  const fx = fxState(view);
  const now = view.time || 0;
  let dt = now - fx.last;
  fx.last = now;
  if (!(dt > 0)) dt = 0;
  if (dt > 0.1) dt = 0.1;
  if (view.fxEvents && view.fxEvents.length) {
    for (const e of view.fxEvents) fx.pending.push({ at: now + (e.delay || 0), e });
    view.fxEvents.length = 0;
  }
  if (fx.pending.length) {
    fx.pending = fx.pending.filter((p) => {
      if (p.at > now) return true;
      spawn(fx, p.e, colorOf);
      return false;
    });
  }
  if (dt > 0) {
    const drag = Math.exp(-2.4 * dt);
    for (const p of fx.parts) {
      p.vx *= drag;
      p.vy = p.vy * drag + 7 * dt; // 살짝 떨어지는 불꽃
      p.x += p.vx * dt;
      p.y += p.vy * dt;
    }
    stepList(fx.parts, dt);
    stepList(fx.boxes, dt);
    stepList(fx.rings, dt);
    stepList(fx.beams, dt);
    stepList(fx.flashes, dt);
    fx.grid = Math.max(0, fx.grid - dt * 1.7);
  }
  return fx;
}

function roundRectPath(ctx, x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

// 격자 번쩍임 (슬라임 아래, 배경 위에 그림)
export function drawFxBackground(ctx, fx, cs, W, H, pad, bw, bh) {
  if (fx.grid <= 0 && !fx.beams.length) return;
  ctx.save();
  ctx.globalCompositeOperation = 'lighter';
  if (fx.grid > 0) {
    const a = fx.grid * fx.grid;
    ctx.strokeStyle = rgba(fx.gridColor, 0.5 * a);
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    for (let x = 1; x < W; x++) { ctx.moveTo(x * cs + 0.5, 0); ctx.lineTo(x * cs + 0.5, bh); }
    for (let y = 1; y < H; y++) { const py = (y - 1) * cs + pad + 0.5; ctx.moveTo(0, py); ctx.lineTo(bw, py); }
    ctx.stroke();
    // 판 안쪽 테두리
    ctx.strokeStyle = rgba(fx.gridColor, 0.8 * a);
    ctx.lineWidth = 3;
    ctx.strokeRect(1.5, 1.5, bw - 3, bh - 3);
  }
  // 빛기둥 (4연쇄부터)
  for (const b of fx.beams) {
    const k = b.age / b.life;
    const a = Math.pow(1 - k, 1.6) * 0.32;
    const cx = b.x * cs;
    const w = cs * (0.55 + 0.35 * (1 - k));
    const gr = ctx.createLinearGradient(cx - w, 0, cx + w, 0);
    gr.addColorStop(0, rgba(b.color, 0));
    gr.addColorStop(0.5, rgba(b.color, a));
    gr.addColorStop(1, rgba(b.color, 0));
    ctx.fillStyle = gr;
    ctx.fillRect(cx - w, 0, w * 2, bh);
    ctx.fillStyle = rgba('#ffffff', a * 0.9);
    ctx.fillRect(cx - 1, 0, 2, bh);
  }
  ctx.restore();
}

// 입자·고리·번쩍임 (슬라임 위에 그림)
export function drawFxForeground(ctx, fx, cs, pad, bw, bh) {
  const px = (x) => x * cs;
  const py = (y) => (y - 1) * cs + pad;
  ctx.save();
  ctx.globalCompositeOperation = 'lighter';
  // 터진 자리에서 퍼지는 빛
  for (const f of fx.flashes) {
    const k = f.age / f.life;
    const a = f.power * (1 - k) * (1 - k);
    const r = cs * (2 + 4 * k);
    const gr = ctx.createRadialGradient(px(f.x), py(f.y), 0, px(f.x), py(f.y), r);
    gr.addColorStop(0, rgba(f.color, a));
    gr.addColorStop(1, rgba(f.color, 0));
    ctx.fillStyle = gr;
    ctx.fillRect(0, 0, bw, bh);
  }
  // 칸마다 퍼지는 네온 테두리
  for (const b of fx.boxes) {
    const k = b.age / b.life;
    const s = cs * (0.9 + 0.7 * k);
    const x = px(b.x) - s / 2, y = py(b.y) - s / 2;
    ctx.strokeStyle = rgba(b.color, 0.55 * (1 - k));
    ctx.lineWidth = cs * 0.22 * (1 - k) + 1;
    roundRectPath(ctx, x, y, s, s, s * 0.3);
    ctx.stroke();
    ctx.strokeStyle = rgba('#ffffff', 0.9 * (1 - k));
    ctx.lineWidth = Math.max(1, cs * 0.05 * (1 - k));
    ctx.stroke();
  }
  // 충격파 고리
  for (const r of fx.rings) {
    if (r.age < 0) continue;
    const k = r.age / r.life;
    const e = 1 - Math.pow(1 - k, 3);
    const rad = (r.r0 + (r.r1 - r.r0) * e) * cs;
    const a = 1 - k;
    ctx.beginPath();
    ctx.arc(px(r.x), py(r.y), rad, 0, Math.PI * 2);
    ctx.strokeStyle = rgba(r.color, 0.3 * a);
    ctx.lineWidth = r.w * cs * (1 - k) * 2 + 1;
    ctx.stroke();
    ctx.strokeStyle = rgba(r.color, 0.95 * a);
    ctx.lineWidth = Math.max(1, r.w * cs * 0.45 * (1 - k));
    ctx.stroke();
  }
  // 불꽃 입자 (꼬리 + 빛나는 머리)
  ctx.lineCap = 'round';
  for (const p of fx.parts) {
    const k = p.age / p.life;
    const a = 1 - k;
    const size = p.size * cs * (1 - 0.45 * k);
    const x = px(p.x), y = py(p.y);
    ctx.strokeStyle = rgba(p.color, 0.75 * a);
    ctx.lineWidth = Math.max(1, size * 0.5);
    ctx.beginPath();
    ctx.moveTo(x, y);
    ctx.lineTo(x - p.vx * cs * 0.045, y - p.vy * cs * 0.045);
    ctx.stroke();
    ctx.globalAlpha = a;
    const g = size * 3.4;
    ctx.drawImage(glowSprite(p.color), x - g / 2, y - g / 2, g, g);
    ctx.globalAlpha = 1;
  }
  ctx.restore();
}

// ---------------- 네온 간판 글씨 ----------------

// 글자 하나를 네온관처럼: 색 번짐 → 색 관 → 하얀 심
function neonStroke(g, text, x, y, color, cs, strong, echo) {
  g.lineJoin = 'round';
  if (echo) {
    // 살짝 어긋난 두 번째 색 테두리 (복고풍 네온 간판 느낌)
    g.save();
    g.globalAlpha = 0.55;
    g.shadowColor = echo;
    g.shadowBlur = cs * 0.3;
    g.strokeStyle = echo;
    g.lineWidth = cs * 0.06;
    g.strokeText(text, x + cs * 0.06, y + cs * 0.06);
    g.restore();
  }
  g.shadowColor = color;
  g.shadowBlur = cs * (strong ? 0.7 : 0.45);
  g.strokeStyle = color;
  g.lineWidth = cs * 0.16;
  g.strokeText(text, x, y);
  g.shadowBlur = cs * 0.22;
  g.lineWidth = cs * 0.1;
  g.strokeText(text, x, y);
  g.shadowBlur = 0;
  // 관 안쪽: 어둡게 깔고 연쇄 색을 은은하게 채워서, 바쁜 판 위에서도 또렷하게
  g.fillStyle = 'rgba(12, 4, 32, 0.5)';
  g.fillText(text, x, y);
  g.fillStyle = rgba(color, 0.28);
  g.fillText(text, x, y);
  g.strokeStyle = '#ffffff';
  g.lineWidth = Math.max(1.2, cs * 0.045);
  g.strokeText(text, x, y);
}

// 두 번째 테두리 색: 분홍 계열엔 하늘, 그 밖엔 분홍
function echoOf(color) {
  return color === '#ff4fd8' || color === '#ff6a8a' || color === '#b06bff' ? '#4ff0ff' : '#ff4fd8';
}

// 연쇄 글자 그림 (한 번 만들어 popup에 기억)
function labelImage(pop, cs) {
  const s = dpr();
  const key = `${cs}:${s}`;
  if (pop._img && pop._img.key === key) return pop._img;
  const n = pop.chain || 0;
  const color = pop.kind === 'allclear' ? '#ffe45c' : chainColor(n);
  const big = n >= 2;
  const parts = [];
  if (pop.kind === 'chain' && big) {
    parts.push({ text: String(n), font: `900 ${Math.round(cs * 1.55)}px ${DIGITS}`, size: cs * 1.55 });
    parts.push({ text: '연쇄!', font: `${Math.round(cs * 0.95)}px ${FONT}`, size: cs * 0.95 });
  } else {
    const size = pop.kind === 'allclear' ? cs * 0.85 : cs * 0.9;
    parts.push({ text: pop.text, font: `${Math.round(size)}px ${FONT}`, size });
  }
  const sub = pop.sub ? { text: pop.sub, font: `${Math.round(cs * 0.5)}px ${FONT}`, size: cs * 0.5 } : null;
  const m = document.createElement('canvas').getContext('2d');
  let lineW = 0;
  const gap = cs * 0.12;
  for (const p of parts) { m.font = p.font; p.w = m.measureText(p.text).width; lineW += p.w; }
  lineW += gap * (parts.length - 1);
  let subW = 0;
  if (sub) { m.font = sub.font; subW = m.measureText(sub.text).width; }
  const lineH = Math.max(...parts.map((p) => p.size)) * 1.1;
  const subH = sub ? sub.size * 1.25 : 0;
  const padX = cs * 0.75, padY = cs * 0.6;
  const w = Math.max(lineW, subW) + padX * 2;
  const h = lineH + subH + padY * 2;
  const cv = document.createElement('canvas');
  cv.width = Math.ceil(w * s);
  cv.height = Math.ceil(h * s);
  const g = cv.getContext('2d');
  g.scale(s, s);
  g.textBaseline = 'alphabetic';
  g.textAlign = 'left';
  // 6연쇄부터: 무지개 네온
  let stroke = color;
  if (n >= 6 && pop.kind === 'chain') {
    const gr = g.createLinearGradient(padX, 0, padX + lineW, 0);
    gr.addColorStop(0, '#ff4fd8');
    gr.addColorStop(0.35, '#ffe45c');
    gr.addColorStop(0.7, '#4ff0ff');
    gr.addColorStop(1, '#b06bff');
    stroke = gr;
  }
  const base = padY + lineH * 0.82;
  let x = (w - lineW) / 2;
  for (const p of parts) {
    g.font = p.font;
    neonStroke(g, p.text, x, base, typeof stroke === 'string' ? stroke : '#ff4fd8', cs, big, big ? echoOf(color) : null);
    if (typeof stroke !== 'string') {
      // 무지개: 색 관을 한 번 더 그라데이션으로 덮음
      g.save();
      g.strokeStyle = stroke;
      g.lineWidth = cs * 0.1;
      g.shadowColor = '#ffffff';
      g.shadowBlur = cs * 0.2;
      g.strokeText(p.text, x, base);
      g.restore();
      g.strokeStyle = '#ffffff';
      g.lineWidth = Math.max(1.2, cs * 0.045);
      g.strokeText(p.text, x, base);
    }
    x += p.w + gap;
  }
  if (sub) {
    g.font = sub.font;
    neonStroke(g, sub.text, (w - subW) / 2, padY + lineH + sub.size * 1.02, color, cs * 0.75, false);
  }
  pop._img = { key, cv, w, h };
  return pop._img;
}

// 네온관이 켜질 때처럼 깜빡깜빡
const FLICKER = [0.15, 0.85, 0.3, 1, 0.6, 1, 0.85, 1];

export function drawLabel(ctx, pop, cs, pad, bw, bh) {
  if (pop.t < 0) return; // 아직 차례가 안 됨 (상대 화면은 조금 늦게 띄움)
  const img = labelImage(pop, cs);
  const k = pop.t / pop.life;
  const n = pop.chain || 0;
  const big = pop.kind !== 'chain' || n >= 2;
  // 판보다 넓으면 줄여서 맞춤
  const fit = Math.min(1, (bw * 0.98) / img.w);
  // 쾅 하고 들어왔다가 살짝 숨 쉬듯
  const inK = Math.min(1, pop.t / (big ? 0.16 : 0.12));
  let scale = big ? 1 + 0.45 * Math.pow(1 - inK, 2) : 0.7 + 0.3 * inK;
  if (k > 0.72) scale *= 1 + (k - 0.72) * 0.35;
  scale *= fit;
  let a = pop.t < 0.16 ? FLICKER[Math.min(FLICKER.length - 1, Math.floor(pop.t / 0.02))] : 1;
  if (k > 0.72) a *= Math.max(0, 1 - (k - 0.72) / 0.28);
  const w = img.w * scale, h = img.h * scale;
  // 터진 자리 근처에 (판 밖으로 나가지 않게)
  let cx = pop.gx != null ? pop.gx * cs : bw / 2;
  // 터진 자리를 가리지 않게 한 칸쯤 위에
  let cy = pop.gy != null ? (pop.gy - 1) * cs + pad - cs * (big ? 0.95 : 0.75) : bh * 0.42;
  cy -= k * cs * (big ? 0.7 : 1.1);
  cx = Math.min(Math.max(cx, w / 2 - cs * 0.6), bw - w / 2 + cs * 0.6);
  cy = Math.min(Math.max(cy, h / 2 - cs * 0.4), bh - h / 2 + cs * 0.4);
  ctx.save();
  ctx.globalAlpha = a;
  ctx.drawImage(img.cv, cx - w / 2, cy - h / 2, w, h);
  ctx.restore();
}
