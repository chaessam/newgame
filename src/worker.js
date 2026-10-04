// 구구팡 슬라임 Cloudflare 서버
// - 정적 파일(public/)은 Cloudflare가 바로 제공
// - Lobby: 방 목록 + 랭킹 데이터베이스 (전체에서 하나)
// - GameRoom: 대결방 하나당 하나
// 모두 WebSocket Hibernation API를 써서, 메시지를 처리하지 않는 동안에는 요금이 들지 않습니다.
import { DurableObject } from 'cloudflare:workers';
import {
  normalizeSchool, normalizeNick, normalizeRegion, identityError, shortSchool,
  MIN_GAMES_FOR_WINRATE, MIN_GAME_SECONDS,
} from '../public/js/identity.js';

const HEARTBEAT_MS = 60 * 1000;      // 방이 살아 있다고 로비에 알리는 주기
const STALE_MS = 3 * HEARTBEAT_MS;   // 이 시간 동안 소식이 없는 방은 목록에서 지움
const RANK_CACHE_MS = 60 * 1000;
const MAX_STATE_BYTES = 4000;

const clean = (s, max) => String(s ?? '').replace(/[\u0000-\u001f<>]/g, '').trim().slice(0, max);

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
  });
}

function randomId() {
  const chars = 'abcdefghijkmnpqrstuvwxyz23456789';
  const bytes = crypto.getRandomValues(new Uint8Array(8));
  return [...bytes].map((b) => chars[b % chars.length]).join('');
}

function acceptSocket(ctx, request) {
  if (request.headers.get('Upgrade') !== 'websocket') {
    return new Response('WebSocket 연결이 필요해요.', { status: 426 });
  }
  const [client, server] = Object.values(new WebSocketPair());
  ctx.acceptWebSocket(server);
  return new Response(null, { status: 101, webSocket: client });
}

function send(ws, type, data = {}) {
  try { ws.send(JSON.stringify({ type, ...data })); } catch { /* 이미 끊긴 연결 */ }
}

const lobbyOf = (env) => env.LOBBY.get(env.LOBBY.idFromName('main'));

export default {
  async fetch(request, env) {
    const { pathname } = new URL(request.url);
    if (pathname === '/ws/lobby' || pathname.startsWith('/api/')) return lobbyOf(env).fetch(request);
    const m = pathname.match(/^\/ws\/room\/([a-z0-9]{8})$/);
    if (m) return env.ROOM.get(env.ROOM.idFromName(m[1])).fetch(request);
    return env.ASSETS.fetch(request);
  },
};

// ---------------------------------------------------------------- 로비 + 랭킹

export class Lobby extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.sql = ctx.storage.sql;
    this.cache = new Map();
    this.sql.exec(`
      CREATE TABLE IF NOT EXISTS players (
        region TEXT NOT NULL, school TEXT NOT NULL, nick TEXT NOT NULL,
        wins INTEGER NOT NULL DEFAULT 0, games INTEGER NOT NULL DEFAULT 0, updated INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY (region, school, nick)
      );
      CREATE INDEX IF NOT EXISTS players_wins ON players (wins DESC, games);
      CREATE INDEX IF NOT EXISTS players_rate ON players ((CAST(wins AS REAL) / games) DESC, wins DESC)
        WHERE games >= ${MIN_GAMES_FOR_WINRATE};
      CREATE TABLE IF NOT EXISTS schools (
        region TEXT NOT NULL, school TEXT NOT NULL,
        wins INTEGER NOT NULL DEFAULT 0, games INTEGER NOT NULL DEFAULT 0, players INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY (region, school)
      );
      CREATE INDEX IF NOT EXISTS schools_wins ON schools (wins DESC);
      CREATE TABLE IF NOT EXISTS rooms (
        id TEXT PRIMARY KEY, title TEXT, host TEXT, count INTEGER, max INTEGER, status TEXT, updated INTEGER
      );
    `);
    ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair('ping', 'pong'));
  }

  async fetch(request) {
    const url = new URL(request.url);
    const q = url.searchParams;
    if (url.pathname === '/ws/lobby') return acceptSocket(this.ctx, request);
    if (url.pathname === '/api/rank') return json(this.ranking(q.get('type')));
    if (url.pathname === '/api/me') return json(this.me(q.get('region'), q.get('school'), q.get('nick')));
    return json({ error: 'not found' }, 404);
  }

  async webSocketMessage(ws, raw) {
    let m;
    try { m = JSON.parse(raw); } catch { return; }
    if (!m || typeof m.type !== 'string') return;
    if (m.type === 'hello' || m.type === 'listRooms') {
      send(ws, 'rooms', { rooms: this.listRooms() });
    } else if (m.type === 'createRoom') {
      const id = randomId();
      const host = normalizeNick(m.name) || '친구';
      const title = clean(m.title, 20) || `${host}의 방`;
      const max = Math.min(4, Math.max(2, Number(m.max) || 2));
      await this.env.ROOM.get(this.env.ROOM.idFromName(id)).init({ id, title, max });
      this.saveRoom({ id, title, host, count: 0, max, status: 'waiting' });
      send(ws, 'roomCreated', { id });
      this.broadcastRooms();
    }
  }

  webSocketClose(ws) {
    try { ws.close(1000, 'bye'); } catch { /* 무시 */ }
  }

  // --- 방 목록 (GameRoom이 호출)

  saveRoom(r) {
    this.sql.exec(
      `INSERT INTO rooms (id, title, host, count, max, status, updated) VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (id) DO UPDATE SET title = excluded.title, host = excluded.host, count = excluded.count,
         max = excluded.max, status = excluded.status, updated = excluded.updated`,
      r.id, r.title, r.host, r.count, r.max, r.status, Date.now(),
    );
  }

  updateRoom(r) {
    this.saveRoom(r);
    this.broadcastRooms();
  }

  removeRoom(id) {
    this.sql.exec('DELETE FROM rooms WHERE id = ?', id);
    this.broadcastRooms();
  }

  listRooms() {
    this.sql.exec('DELETE FROM rooms WHERE updated < ?', Date.now() - STALE_MS);
    return this.sql.exec(
      `SELECT id, title, host, count, max, status FROM rooms
       ORDER BY status = 'playing', updated DESC LIMIT 100`,
    ).toArray();
  }

  broadcastRooms() {
    const sockets = this.ctx.getWebSockets();
    if (!sockets.length) return;
    const msg = JSON.stringify({ type: 'rooms', rooms: this.listRooms() });
    for (const ws of sockets) { try { ws.send(msg); } catch { /* 무시 */ } }
  }

  // --- 랭킹

  recordResult(results) {
    const now = Date.now();
    for (const p of results) {
      const region = normalizeRegion(p.region), school = normalizeSchool(p.school), nick = normalizeNick(p.nick);
      if (identityError({ region, school, nick })) continue;
      const win = p.win ? 1 : 0;
      const existed = this.sql.exec(
        'SELECT 1 FROM players WHERE region = ? AND school = ? AND nick = ?', region, school, nick,
      ).toArray().length > 0;
      this.sql.exec(
        `INSERT INTO players (region, school, nick, wins, games, updated) VALUES (?, ?, ?, ?, 1, ?)
         ON CONFLICT (region, school, nick) DO UPDATE SET wins = wins + excluded.wins, games = games + 1, updated = excluded.updated`,
        region, school, nick, win, now,
      );
      this.sql.exec(
        `INSERT INTO schools (region, school, wins, games, players) VALUES (?, ?, ?, 1, 1)
         ON CONFLICT (region, school) DO UPDATE SET wins = wins + excluded.wins, games = games + 1,
           players = players + ?`,
        region, school, win, existed ? 0 : 1,
      );
    }
    this.cache.clear();
  }

  ranking(type) {
    if (!['wins', 'winrate', 'school'].includes(type)) type = 'wins';
    const hit = this.cache.get(type);
    if (hit && Date.now() - hit.t < RANK_CACHE_MS) return hit.data;
    let rows;
    if (type === 'wins') {
      rows = this.sql.exec(
        `SELECT region, school, nick, wins, games FROM players WHERE wins > 0
         ORDER BY wins DESC, games LIMIT 50`,
      ).toArray();
    } else if (type === 'winrate') {
      rows = this.sql.exec(
        `SELECT region, school, nick, wins, games FROM players WHERE games >= ${MIN_GAMES_FOR_WINRATE}
         ORDER BY (CAST(wins AS REAL) / games) DESC, wins DESC LIMIT 50`,
      ).toArray();
    } else {
      rows = this.sql.exec(
        `SELECT region, school, wins, games, players FROM schools WHERE wins > 0
         ORDER BY wins DESC LIMIT 50`,
      ).toArray();
    }
    const data = { type, minGames: MIN_GAMES_FOR_WINRATE, rows };
    this.cache.set(type, { t: Date.now(), data });
    return data;
  }

  me(region, school, nick) {
    region = normalizeRegion(region); school = normalizeSchool(school); nick = normalizeNick(nick);
    if (identityError({ region, school, nick })) return { found: false };
    const row = this.sql.exec(
      'SELECT wins, games FROM players WHERE region = ? AND school = ? AND nick = ?', region, school, nick,
    ).toArray()[0];
    if (!row) return { found: false, school };
    const winsRank = row.wins > 0
      ? this.sql.exec('SELECT COUNT(*) AS n FROM players WHERE wins > ?', row.wins).one().n + 1
      : null;
    const sc = this.sql.exec(
      'SELECT wins FROM schools WHERE region = ? AND school = ?', region, school,
    ).toArray()[0];
    const schoolRank = sc && sc.wins > 0
      ? this.sql.exec('SELECT COUNT(*) AS n FROM schools WHERE wins > ?', sc.wins).one().n + 1
      : null;
    return { found: true, school, wins: row.wins, games: row.games, winsRank, schoolRank, schoolWins: sc ? sc.wins : 0 };
  }
}

// ---------------------------------------------------------------- 대결방

export class GameRoom extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.meta = null;
    ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair('ping', 'pong'));
  }

  async load() {
    if (!this.meta) this.meta = (await this.ctx.storage.get('meta')) || null;
    return this.meta;
  }

  async save() { await this.ctx.storage.put('meta', this.meta); }

  // 로비가 방을 만들 때 호출
  async init({ id, title, max }) {
    this.meta = { id, title, max, hostId: null, status: 'waiting', seed: 0, startedAt: 0, nextPid: 1, participants: [] };
    await this.save();
    await this.ctx.storage.setAlarm(Date.now() + HEARTBEAT_MS);
  }

  async fetch(request) {
    return acceptSocket(this.ctx, request);
  }

  // 방에 들어와 있는 플레이어 (exclude: 막 끊긴 연결)
  players(exclude) {
    return this.ctx.getWebSockets()
      .filter((ws) => ws !== exclude && ws.readyState === 1)
      .map((ws) => ({ ws, a: ws.deserializeAttachment() }))
      .filter((p) => p.a && p.a.id)
      .sort((x, y) => x.a.joinedAt - y.a.joinedAt);
  }

  info(ps = this.players()) {
    const m = this.meta;
    return {
      id: m.id, title: m.title, hostId: m.hostId, max: m.max, status: m.status,
      players: ps.map(({ a }) => ({ id: a.id, name: a.nick, school: shortSchool(a.school), ready: a.ready, host: a.id === m.hostId })),
    };
  }

  broadcast(type, data, exceptWs, ps = this.players()) {
    const msg = JSON.stringify({ type, ...data });
    for (const { ws } of ps) {
      if (ws === exceptWs) continue;
      try { ws.send(msg); } catch { /* 무시 */ }
    }
  }

  async syncLobby(ps = this.players()) {
    const m = this.meta;
    const host = ps.find((p) => p.a.id === m.hostId);
    await lobbyOf(this.env).updateRoom({
      id: m.id, title: m.title, host: host ? host.a.nick : '', count: ps.length, max: m.max, status: m.status,
    });
  }

  fail(ws, message) {
    send(ws, 'error', { message, fatal: true });
    try { ws.close(4000, 'rejected'); } catch { /* 무시 */ }
  }

  async webSocketMessage(ws, raw) {
    if (typeof raw !== 'string' || raw.length > MAX_STATE_BYTES) return;
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }
    if (!msg || typeof msg.type !== 'string') return;
    const m = await this.load();
    if (!m) return this.fail(ws, '방이 없어졌어요.');
    const a = ws.deserializeAttachment();

    if (msg.type === 'join') return this.join(ws, msg);
    if (!a || !a.id) return;

    switch (msg.type) {
      case 'ready':
        if (m.status !== 'waiting') return;
        a.ready = !!msg.ready;
        ws.serializeAttachment(a);
        this.broadcast('room', { room: this.info() });
        return;
      case 'start':
        return this.start(ws, a);
      case 'state':
        if (m.status === 'playing' && a.alive) this.broadcast('state', { id: a.id, s: msg.s }, ws);
        return;
      case 'attack': {
        if (m.status !== 'playing' || !a.alive) return;
        const n = Math.min(999, Math.max(0, Math.floor(Number(msg.n) || 0)));
        if (!n) return;
        const targets = this.players().filter((p) => p.ws !== ws && p.a.alive);
        this.broadcast('attack', { from: a.id, n }, ws, targets);
        return;
      }
      case 'dead':
        if (m.status !== 'playing' || !a.alive) return;
        a.alive = false;
        ws.serializeAttachment(a);
        this.broadcast('playerDead', { id: a.id });
        return this.checkEnd();
      case 'leave':
        await this.leave(ws);
        try { ws.close(1000, 'leave'); } catch { /* 무시 */ }
    }
  }

  async join(ws, msg) {
    const m = this.meta;
    const cur = ws.deserializeAttachment();
    if (cur && cur.id) return;
    const region = normalizeRegion(msg.region), school = normalizeSchool(msg.school), nick = normalizeNick(msg.nick);
    const err = identityError({ region, school, nick });
    if (err) return this.fail(ws, err);
    if (m.status !== 'waiting') return this.fail(ws, '이미 게임 중인 방이에요.');
    const ps = this.players();
    if (ps.length >= m.max) return this.fail(ws, '방이 가득 찼어요.');
    if (ps.some((p) => p.a.region === region && p.a.school === school && p.a.nick === nick)) {
      return this.fail(ws, '같은 학교에 같은 닉네임인 친구가 이미 방에 있어요.');
    }
    const a = { id: m.nextPid++, region, school, nick, ready: false, alive: false, joinedAt: Date.now() };
    ws.serializeAttachment(a);
    if (!m.hostId || !ps.some((p) => p.a.id === m.hostId)) m.hostId = a.id;
    await this.save();
    const all = this.players();
    send(ws, 'joined', { you: a.id, room: this.info(all) });
    this.broadcast('room', { room: this.info(all) }, ws, all);
    await this.syncLobby(all);
  }

  async start(ws, a) {
    const m = this.meta;
    if (m.hostId !== a.id || m.status !== 'waiting') return;
    const ps = this.players();
    if (ps.length < 2) return send(ws, 'error', { message: '2명 이상 모여야 시작할 수 있어요.' });
    if (ps.some((p) => p.a.id !== m.hostId && !p.a.ready)) {
      return send(ws, 'error', { message: '모두 준비 완료를 눌러야 시작할 수 있어요.' });
    }
    m.status = 'playing';
    m.seed = crypto.getRandomValues(new Uint32Array(1))[0] >>> 1;
    m.startedAt = Date.now();
    m.participants = ps.map(({ a: p }) => ({ id: p.id, region: p.region, school: p.school, nick: p.nick }));
    for (const p of ps) { p.a.alive = true; p.ws.serializeAttachment(p.a); }
    await this.save();
    this.broadcast('start', { seed: m.seed, players: ps.map(({ a: p }) => ({ id: p.id, name: p.nick })) }, null, ps);
    this.broadcast('room', { room: this.info(ps) }, null, ps);
    await this.syncLobby(ps);
  }

  async checkEnd(exclude) {
    const m = this.meta;
    if (m.status !== 'playing') return;
    const ps = this.players(exclude);
    const alive = ps.filter((p) => p.a.alive);
    if (alive.length > 1) return;
    const winner = alive[0] ? alive[0].a : null;
    const seconds = (Date.now() - m.startedAt) / 1000;
    const recorded = seconds >= MIN_GAME_SECONDS && m.participants.length >= 2;
    if (recorded) {
      // 중간에 나간 친구도 패배로 기록합니다.
      await lobbyOf(this.env).recordResult(m.participants.map((p) => ({ ...p, win: !!winner && p.id === winner.id })));
    }
    m.status = 'waiting';
    m.participants = [];
    for (const p of ps) { p.a.alive = false; p.a.ready = false; p.ws.serializeAttachment(p.a); }
    await this.save();
    this.broadcast('gameOver', { winnerId: winner ? winner.id : null, winner: winner ? winner.nick : null, recorded }, null, ps);
    this.broadcast('room', { room: this.info(ps) }, null, ps);
    await this.syncLobby(ps);
  }

  async leave(ws) {
    const a = ws.deserializeAttachment();
    if (!a || !a.id) return;
    try { ws.serializeAttachment({}); } catch { /* 이미 닫힘 */ }
    const m = await this.load();
    if (!m) return;
    const ps = this.players(ws);
    if (!ps.length) {
      await lobbyOf(this.env).removeRoom(m.id);
      await this.ctx.storage.deleteAlarm();
      await this.ctx.storage.deleteAll();
      this.meta = null;
      return;
    }
    if (m.hostId === a.id) m.hostId = ps[0].a.id;
    if (m.status === 'playing' && a.alive) {
      this.broadcast('playerDead', { id: a.id }, null, ps);
      await this.save();
      await this.checkEnd(ws);
      if (this.meta && this.meta.status === 'waiting') return;
    }
    await this.save();
    this.broadcast('room', { room: this.info(ps) }, null, ps);
    await this.syncLobby(ps);
  }

  async webSocketClose(ws) {
    await this.leave(ws);
    try { ws.close(1000, 'bye'); } catch { /* 무시 */ }
  }

  async webSocketError(ws) {
    await this.leave(ws);
  }

  // 1분마다: 아무도 없으면 방을 정리하고, 있으면 로비에 살아 있다고 알림
  async alarm() {
    const m = await this.load();
    if (!m) return;
    const ps = this.players();
    if (!ps.length) {
      await lobbyOf(this.env).removeRoom(m.id);
      await this.ctx.storage.deleteAll();
      this.meta = null;
      return;
    }
    await this.syncLobby(ps);
    await this.ctx.storage.setAlarm(Date.now() + HEARTBEAT_MS);
  }
}
