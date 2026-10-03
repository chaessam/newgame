// 구구팡 슬라임 서버: 정적 파일 제공 + 온라인 대결 방(WebSocket)
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocketServer } from 'ws';

const PORT = Number(process.env.PORT) || 3000;
const PUBLIC_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), 'public');
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.json': 'application/json',
};

const server = http.createServer((req, res) => {
  let pathname;
  try {
    pathname = decodeURIComponent(new URL(req.url, 'http://x').pathname);
  } catch {
    res.writeHead(400); res.end(); return;
  }
  if (pathname === '/') pathname = '/index.html';
  const file = path.normalize(path.join(PUBLIC_DIR, pathname));
  if (!file.startsWith(PUBLIC_DIR + path.sep)) { res.writeHead(403); res.end(); return; }
  fs.readFile(file, (err, data) => {
    if (err) { res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }); res.end('Not found'); return; }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-cache' });
    res.end(data);
  });
});

const wss = new WebSocketServer({ server, path: '/ws', maxPayload: 16 * 1024 });

let nextId = 1;
const clients = new Map(); // id → { id, ws, name, roomId, alive }
const rooms = new Map();   // id → room

const clean = (s, max) => String(s ?? '').replace(/[\u0000-\u001f<>]/g, '').trim().slice(0, max);

function send(client, type, data = {}) {
  if (client.ws.readyState === 1) client.ws.send(JSON.stringify({ type, ...data }));
}

function roomSummary(r) {
  return {
    id: r.id,
    title: r.title,
    host: clients.get(r.hostId)?.name || '',
    count: r.players.length,
    max: r.max,
    status: r.status,
  };
}

function roomInfo(r) {
  return {
    id: r.id,
    title: r.title,
    hostId: r.hostId,
    max: r.max,
    status: r.status,
    players: r.players.map((id) => {
      const c = clients.get(id);
      return { id, name: c?.name || '?', ready: r.ready.has(id), host: id === r.hostId };
    }),
  };
}

function broadcastLobby() {
  const list = [...rooms.values()].map(roomSummary);
  for (const c of clients.values()) if (!c.roomId && c.name) send(c, 'rooms', { rooms: list });
}

function broadcastRoom(r, type, data, exceptId) {
  for (const id of r.players) {
    if (id === exceptId) continue;
    const c = clients.get(id);
    if (c) send(c, type, data);
  }
}

function sendRoomInfo(r) { broadcastRoom(r, 'room', { room: roomInfo(r) }); }

function checkGameEnd(r) {
  if (r.status !== 'playing') return;
  if (r.alive.size > 1) return;
  const winnerId = r.alive.size === 1 ? [...r.alive][0] : null;
  r.status = 'waiting';
  r.ready.clear();
  r.alive.clear();
  broadcastRoom(r, 'gameOver', { winnerId, winner: winnerId ? clients.get(winnerId)?.name : null });
  sendRoomInfo(r);
  broadcastLobby();
}

function leaveRoom(c) {
  const r = rooms.get(c.roomId);
  c.roomId = null;
  if (!r) return;
  r.players = r.players.filter((id) => id !== c.id);
  r.ready.delete(c.id);
  if (r.status === 'playing' && r.alive.delete(c.id)) {
    broadcastRoom(r, 'playerDead', { id: c.id });
  }
  if (!r.players.length) {
    rooms.delete(r.id);
  } else {
    if (r.hostId === c.id) {
      r.hostId = r.players[0];
      r.ready.delete(r.hostId);
    }
    checkGameEnd(r);
    sendRoomInfo(r);
  }
  broadcastLobby();
}

function joinRoom(c, r) {
  c.roomId = r.id;
  r.players.push(c.id);
  send(c, 'joined', { room: roomInfo(r) });
  sendRoomInfo(r);
  broadcastLobby();
}

const handlers = {
  hello(c, m) {
    c.name = clean(m.name, 10) || `친구${c.id}`;
    send(c, 'welcome', { id: c.id, name: c.name });
    send(c, 'rooms', { rooms: [...rooms.values()].map(roomSummary) });
  },
  listRooms(c) {
    send(c, 'rooms', { rooms: [...rooms.values()].map(roomSummary) });
  },
  createRoom(c, m) {
    if (!c.name) return;
    if (c.roomId) leaveRoom(c);
    const max = Math.min(4, Math.max(2, Number(m.max) || 2));
    const r = {
      id: String(nextId++),
      title: clean(m.title, 20) || `${c.name}의 방`,
      hostId: c.id,
      max,
      players: [],
      ready: new Set(),
      alive: new Set(),
      status: 'waiting',
    };
    rooms.set(r.id, r);
    joinRoom(c, r);
  },
  joinRoom(c, m) {
    if (!c.name) return;
    const r = rooms.get(String(m.id));
    if (!r) return send(c, 'error', { message: '방이 없어졌어요.' });
    if (r.status !== 'waiting') return send(c, 'error', { message: '이미 게임 중인 방이에요.' });
    if (r.players.length >= r.max) return send(c, 'error', { message: '방이 가득 찼어요.' });
    if (c.roomId === r.id) return;
    if (c.roomId) leaveRoom(c);
    joinRoom(c, r);
  },
  leaveRoom(c) {
    if (c.roomId) leaveRoom(c);
    send(c, 'rooms', { rooms: [...rooms.values()].map(roomSummary) });
  },
  ready(c, m) {
    const r = rooms.get(c.roomId);
    if (!r || r.status !== 'waiting') return;
    if (m.ready) r.ready.add(c.id); else r.ready.delete(c.id);
    sendRoomInfo(r);
  },
  start(c) {
    const r = rooms.get(c.roomId);
    if (!r || r.hostId !== c.id || r.status !== 'waiting') return;
    if (r.players.length < 2) return send(c, 'error', { message: '2명 이상 모여야 시작할 수 있어요.' });
    const notReady = r.players.filter((id) => id !== r.hostId && !r.ready.has(id));
    if (notReady.length) return send(c, 'error', { message: '모두 준비 완료를 눌러야 시작할 수 있어요.' });
    r.status = 'playing';
    r.alive = new Set(r.players);
    const seed = Math.floor(Math.random() * 2 ** 31);
    const players = r.players.map((id) => ({ id, name: clients.get(id)?.name || '?' }));
    broadcastRoom(r, 'start', { seed, players });
    sendRoomInfo(r);
    broadcastLobby();
  },
  state(c, m) {
    const r = rooms.get(c.roomId);
    if (!r || r.status !== 'playing' || !r.alive.has(c.id)) return;
    broadcastRoom(r, 'state', { id: c.id, s: m.s }, c.id);
  },
  attack(c, m) {
    const r = rooms.get(c.roomId);
    if (!r || r.status !== 'playing' || !r.alive.has(c.id)) return;
    const n = Math.min(999, Math.max(0, Math.floor(Number(m.n) || 0)));
    if (!n) return;
    for (const id of r.alive) {
      if (id === c.id) continue;
      const o = clients.get(id);
      if (o) send(o, 'attack', { from: c.id, n });
    }
  },
  dead(c) {
    const r = rooms.get(c.roomId);
    if (!r || r.status !== 'playing' || !r.alive.has(c.id)) return;
    r.alive.delete(c.id);
    broadcastRoom(r, 'playerDead', { id: c.id });
    checkGameEnd(r);
  },
};

wss.on('connection', (ws) => {
  const c = { id: nextId++, ws, name: '', roomId: null, isAlive: true };
  clients.set(c.id, c);
  ws.on('pong', () => { c.isAlive = true; });
  ws.on('message', (raw) => {
    let m;
    try { m = JSON.parse(raw); } catch { return; }
    const h = m && typeof m.type === 'string' && Object.hasOwn(handlers, m.type) ? handlers[m.type] : null;
    if (h) h(c, m);
  });
  ws.on('close', () => {
    if (c.roomId) leaveRoom(c);
    clients.delete(c.id);
  });
});

// 끊긴 연결 정리
setInterval(() => {
  for (const c of clients.values()) {
    if (!c.isAlive) { c.ws.terminate(); continue; }
    c.isAlive = false;
    try { c.ws.ping(); } catch { /* 무시 */ }
  }
}, 20000).unref();

server.listen(PORT, () => {
  console.log(`구구팡 슬라임 서버 실행 중: http://localhost:${PORT}`);
});
