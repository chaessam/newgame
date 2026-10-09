// 구구팡 슬라임 Cloudflare 서버
// - 정적 파일(public/)은 Cloudflare가 바로 제공
// - Lobby: 방 목록 + 랭킹 데이터베이스 (전체에서 하나)
// - GameRoom: 대결방 하나당 하나
// 모두 WebSocket Hibernation API를 써서, 메시지를 처리하지 않는 동안에는 요금이 들지 않습니다.
import { DurableObject } from 'cloudflare:workers';
import {
  normalizeNick, normalizeSchoolCode, identityError, MIN_GAMES_FOR_WINRATE, MIN_GAME_SECONDS,
} from '../public/js/identity.js';
import { hasProfanity } from '../public/js/profanity.js';
import { EMOTES, EMOTE_COOLDOWN_MS } from '../public/js/emotes.js';
import { SCHOOLS_PATH, indexSchools, shortSchool, placeOf } from '../public/js/schools.js';
import { MASTER_RP, RP_SEED_PER_WIN, tierOf, applyResult, weekKey } from '../public/js/tiers.js';
import { earnedTitles, displayTitle } from '../public/js/titles.js';

const HEARTBEAT_MS = 5 * 60 * 1000;  // 방이 살아 있다고 로비에 알리는 주기 (무료 한도를 아끼려고 5분)
const STALE_MS = 3 * HEARTBEAT_MS;   // 이 시간 동안 소식이 없는 방은 목록에서 지움
const RANK_CACHE_MS = 60 * 1000;
const MAX_STATE_BYTES = 4000;
const WEEK_MIN_GAMES = 5; // 이번 주 승률 랭킹에 오르는 최소 판 수

const DAY_MS = 24 * 3600 * 1000;
const playerKey = (school, nick) => `${school}\n${nick}`;

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

// 전국 초등학교 목록 (public/data/schools.json). 처음 한 번만 읽어서 기억해 둡니다.
let schoolIndex = null;
async function loadSchools(env) {
  if (schoolIndex) return schoolIndex;
  try {
    const res = await env.ASSETS.fetch(`https://assets.local${SCHOOLS_PATH}`);
    if (!res.ok) throw new Error(String(res.status));
    schoolIndex = indexSchools(await res.json());
    return schoolIndex;
  } catch {
    return indexSchools(null);
  }
}

// 학교 코드와 닉네임을 확인해서 { school, nick } 또는 { error } 를 돌려줌
async function checkIdentity(env, schoolCode, nick) {
  schoolCode = normalizeSchoolCode(schoolCode);
  nick = normalizeNick(nick);
  const error = identityError({ schoolCode, nick });
  if (error) return { error };
  const school = (await loadSchools(env)).byCode.get(schoolCode);
  if (!school) return { error: '학교를 검색해서 다시 골라 주세요.' };
  return { school, nick };
}

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
        school TEXT NOT NULL, nick TEXT NOT NULL,
        wins INTEGER NOT NULL DEFAULT 0, games INTEGER NOT NULL DEFAULT 0, updated INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY (school, nick)
      );
      CREATE INDEX IF NOT EXISTS players_wins ON players (wins DESC, games);
      CREATE INDEX IF NOT EXISTS players_rate ON players ((CAST(wins AS REAL) / games) DESC, wins DESC)
        WHERE games >= ${MIN_GAMES_FOR_WINRATE};
      CREATE TABLE IF NOT EXISTS schools (
        school TEXT PRIMARY KEY,
        wins INTEGER NOT NULL DEFAULT 0, games INTEGER NOT NULL DEFAULT 0, players INTEGER NOT NULL DEFAULT 0
      );
      CREATE INDEX IF NOT EXISTS schools_wins ON schools (wins DESC);
      CREATE TABLE IF NOT EXISTS rooms (
        id TEXT PRIMARY KEY, title TEXT, host TEXT, count INTEGER, max INTEGER, status TEXT, updated INTEGER
      );
      CREATE TABLE IF NOT EXISTS participants (
        school TEXT NOT NULL, nick TEXT NOT NULL, PRIMARY KEY (school, nick)
      );
      CREATE TABLE IF NOT EXISTS counters (name TEXT PRIMARY KEY, value INTEGER NOT NULL DEFAULT 0);
      CREATE TABLE IF NOT EXISTS weekly (
        week TEXT NOT NULL, school TEXT NOT NULL, nick TEXT NOT NULL,
        wins INTEGER NOT NULL DEFAULT 0, games INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY (week, school, nick)
      );
      CREATE INDEX IF NOT EXISTS weekly_wins ON weekly (week, wins DESC, games);
    `);
    // 티어·칭호 기능으로 늘어난 칸 (예전 데이터베이스에도 더함)
    this.addColumn('players', 'rp', 'INTEGER NOT NULL DEFAULT 0');
    this.addColumn('players', 'streak', 'INTEGER NOT NULL DEFAULT 0');
    this.addColumn('players', 'best_streak', 'INTEGER NOT NULL DEFAULT 0');
    this.addColumn('players', 'title', "TEXT NOT NULL DEFAULT ''");
    this.addColumn('rooms', 'host_tier', "TEXT NOT NULL DEFAULT ''");
    this.sql.exec('CREATE INDEX IF NOT EXISTS players_rp ON players (rp DESC, updated)');
    this.seedCounters();
    this.seedTiers();
    ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair('ping', 'pong'));
  }

  addColumn(table, column, type) {
    const cols = this.sql.exec(`PRAGMA table_info(${table})`).toArray();
    if (!cols.some((c) => c.name === column)) this.sql.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${type}`);
  }

  // 티어가 생기기 전의 기록: 승리 1번에 15점으로 처음 한 번 채움 (진 판은 빼지 않음)
  seedTiers() {
    if (this.counter('tiersSeeded')) return;
    this.sql.exec('UPDATE players SET rp = wins * ? WHERE rp = 0', RP_SEED_PER_WIN);
    this.bump('tiersSeeded');
  }

  async fetch(request) {
    const url = new URL(request.url);
    const q = url.searchParams;
    if (url.pathname === '/ws/lobby') return acceptSocket(this.ctx, request);
    if (url.pathname === '/api/title' && request.method === 'POST') {
      let body = {};
      try { body = await request.json(); } catch { /* 빈 요청 */ }
      return json(await this.setTitle(body));
    }
    if (url.pathname === '/api/stats') return json(this.stats());
    if (url.pathname === '/api/played' && request.method === 'POST') {
      let body = {};
      try { body = await request.json(); } catch { /* 빈 요청 */ }
      return json(await this.played(body));
    }
    if (url.pathname === '/api/rank') return json(await this.ranking(q.get('type'), q.get('period')));
    if (url.pathname === '/api/me') return json(await this.me(q.get('school'), q.get('nick')));
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
      if (hasProfanity(m.title)) return send(ws, 'error', { message: '방 이름에 사용할 수 없는 말이 들어 있어요.' });
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
      `INSERT INTO rooms (id, title, host, host_tier, count, max, status, updated) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (id) DO UPDATE SET title = excluded.title, host = excluded.host, host_tier = excluded.host_tier,
         count = excluded.count, max = excluded.max, status = excluded.status, updated = excluded.updated`,
      r.id, r.title, r.host, r.hostTier || '', r.count, r.max, r.status, Date.now(),
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
      `SELECT id, title, host, host_tier AS hostTier, count, max, status FROM rooms
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

  // ---- 첫 화면 통계: 참여 학교 수, 참여 학생 수, 누적 대결 수 ----
  // 매번 세면 무료 한도(읽는 줄 수)를 많이 쓰니, 숫자를 따로 저장해 두고 1씩 올립니다.

  bump(name, n = 1) {
    this.sql.exec(
      'INSERT INTO counters (name, value) VALUES (?, ?) ON CONFLICT (name) DO UPDATE SET value = value + excluded.value',
      name, n,
    );
  }

  counter(name) {
    const row = this.sql.exec('SELECT value FROM counters WHERE name = ?', name).toArray()[0];
    return row ? row.value : 0;
  }

  // 학생을 처음 보면 학생 수(+학교도 처음이면 학교 수)를 올림
  addParticipant(school, nick) {
    const schoolSeen = this.sql.exec('SELECT 1 FROM participants WHERE school = ? LIMIT 1', school).toArray().length > 0;
    const cur = this.sql.exec('INSERT OR IGNORE INTO participants (school, nick) VALUES (?, ?)', school, nick);
    if (cur.rowsWritten > 0) {
      this.bump('students');
      if (!schoolSeen) this.bump('schools');
    }
  }

  // 통계 기능을 넣기 전의 온라인 대결 기록으로 처음 한 번 숫자를 채움
  seedCounters() {
    if (this.counter('seeded')) return;
    for (const p of this.sql.exec('SELECT school, nick FROM players').toArray()) this.addParticipant(p.school, p.nick);
    const g = this.sql.exec('SELECT COALESCE(SUM(games), 0) AS g FROM players').one().g;
    if (g) this.bump('online', Math.round(g / 2)); // 대부분 2명 대결이라 반으로 어림
    this.bump('seeded');
  }

  stats() {
    if (this.statsCache && Date.now() - this.statsCache.t < RANK_CACHE_MS) return this.statsCache.data;
    const data = {
      schools: this.counter('schools'),
      students: this.counter('students'),
      games: this.counter('online') + this.counter('cpu') + this.counter('solo'),
    };
    this.statsCache = { t: Date.now(), data };
    return data;
  }

  // 컴퓨터 대결·혼자 연습 한 판이 끝날 때 (학교를 골랐으면 참여 학생으로도 셈)
  async played({ mode, schoolCode, nick }) {
    if (mode !== 'cpu' && mode !== 'solo') return { ok: false };
    this.bump(mode);
    if (schoolCode && nick) {
      const id = await checkIdentity(this.env, schoolCode, nick);
      if (!id.error) this.addParticipant(id.school.code, id.nick);
    }
    this.statsCache = null;
    return { ok: true };
  }

  // ---- 티어·칭호 ----

  // 순위 칭호에 쓰는 순위표 (1분 동안 기억)
  rankCtx() {
    if (this.rankCache && Date.now() - this.rankCache.t < RANK_CACHE_MS) return this.rankCache;
    const toMap = (rows) => {
      const m = new Map();
      rows.forEach((r, i) => m.set(playerKey(r.school, r.nick), i + 1));
      return m;
    };
    const week = weekKey();
    const lastWeek = weekKey(Date.now() - 7 * DAY_MS);
    const champ = this.sql.exec(
      'SELECT school, nick FROM weekly WHERE week = ? AND wins > 0 ORDER BY wins DESC, games LIMIT 1', lastWeek,
    ).toArray()[0];
    const topSchool = this.sql.exec('SELECT school FROM schools WHERE wins > 0 ORDER BY wins DESC LIMIT 1').toArray()[0];
    this.rankCache = {
      t: Date.now(),
      week,
      winsTop: toMap(this.sql.exec(
        'SELECT school, nick FROM players WHERE wins > 0 ORDER BY wins DESC, games LIMIT 100',
      ).toArray()),
      rateTop: toMap(this.sql.exec(
        `SELECT school, nick FROM players WHERE games >= ${MIN_GAMES_FOR_WINRATE}
         ORDER BY (CAST(wins AS REAL) / games) DESC, wins DESC LIMIT 10`,
      ).toArray()),
      weekTop: toMap(this.sql.exec(
        'SELECT school, nick FROM weekly WHERE week = ? AND wins > 0 ORDER BY wins DESC, games LIMIT 10', week,
      ).toArray()),
      champion: champ ? playerKey(champ.school, champ.nick) : '',
      topSchool: topSchool ? topSchool.school : '',
    };
    return this.rankCache;
  }

  // 마스터(1000점 이상) 중 점수 순위 — 그랜드마스터·챌린저를 정함
  rpRank(rp) {
    if (rp < MASTER_RP) return null;
    return this.sql.exec('SELECT COUNT(*) AS n FROM players WHERE rp > ?', rp).one().n + 1;
  }

  // 우리 학교 승리 1위인지 (학교 친구 3명 이상일 때만)
  isSchoolAce(school, nick, wins) {
    if (wins <= 0) return false;
    const sc = this.sql.exec('SELECT players FROM schools WHERE school = ?', school).toArray()[0];
    if (!sc || sc.players < 3) return false;
    const top = this.sql.exec(
      'SELECT nick FROM players WHERE school = ? ORDER BY wins DESC, games LIMIT 1', school,
    ).toArray()[0];
    return !!top && top.nick === nick;
  }

  // 한 학생의 티어와 칭호 (기록이 없으면 브론즈, 칭호 없음)
  profile(school, nick, rc = this.rankCtx()) {
    const row = this.sql.exec(
      'SELECT wins, games, rp, best_streak AS bestStreak, title FROM players WHERE school = ? AND nick = ?',
      school, nick,
    ).toArray()[0] || { wins: 0, games: 0, rp: 0, bestStreak: 0, title: '' };
    const key = playerKey(school, nick);
    const rpRank = this.rpRank(row.rp);
    const titles = earnedTitles({
      wins: row.wins,
      games: row.games,
      bestStreak: row.bestStreak,
      winsRank: rc.winsTop.get(key) || null,
      rateRank: rc.rateTop.get(key) || null,
      weekRank: rc.weekTop.get(key) || null,
      champion: rc.champion === key,
      schoolAce: this.isSchoolAce(school, nick, row.wins),
      bestSchool: row.games > 0 && rc.topSchool === school,
    });
    return {
      wins: row.wins,
      games: row.games,
      rp: row.rp,
      rpRank,
      tier: tierOf(row.rp, rpRank).id,
      titles,
      title: displayTitle(row.title, titles),
      chosen: row.title,
    };
  }

  // 대결방에서 이름표에 쓸 티어·대표 칭호 (GameRoom이 호출)
  badge(school, nick) {
    const p = this.profile(school, nick);
    return { tier: p.tier, title: p.title };
  }

  // 대표 칭호 고르기 ('none'이면 달지 않음)
  async setTitle({ schoolCode, nick, title }) {
    const id = await checkIdentity(this.env, schoolCode, nick);
    if (id.error) return { ok: false, error: id.error };
    const code = id.school.code;
    const p = this.profile(code, id.nick);
    const want = String(title || '');
    if (want !== 'none' && p.titles.indexOf(want) < 0) return { ok: false, error: '아직 얻지 못한 칭호예요.' };
    if (!p.games) return { ok: false, error: '온라인 대결을 한 판 하면 칭호를 고를 수 있어요.' };
    this.sql.exec('UPDATE players SET title = ? WHERE school = ? AND nick = ?', want, code, id.nick);
    this.cache.clear();
    return { ok: true, title: displayTitle(want, p.titles) };
  }

  // results: [{ school: 학교코드, nick, win }]  (GameRoom이 확인한 값)
  // 돌려주는 값: 같은 순서로 [{ rpBefore, rpAfter, tierBefore, tierAfter, newTitles, title }]
  recordResult(results) {
    const now = Date.now();
    const week = weekKey(now);
    this.bump('online');
    const rc = this.rankCtx();
    const before = results.map((p) => this.profile(p.school, p.nick, rc));
    results.forEach((p, i) => {
      this.addParticipant(p.school, p.nick);
      const win = p.win ? 1 : 0;
      const existed = before[i].games > 0;
      const rp = applyResult(before[i].rp, win);
      this.sql.exec(
        `INSERT INTO players (school, nick, wins, games, updated, rp, streak, best_streak) VALUES (?, ?, ?, 1, ?, ?, ?, ?)
         ON CONFLICT (school, nick) DO UPDATE SET wins = wins + excluded.wins, games = games + 1,
           updated = excluded.updated, rp = excluded.rp,
           streak = CASE WHEN excluded.wins > 0 THEN streak + 1 ELSE 0 END,
           best_streak = MAX(best_streak, CASE WHEN excluded.wins > 0 THEN streak + 1 ELSE 0 END)`,
        p.school, p.nick, win, now, rp, win, win,
      );
      this.sql.exec(
        `INSERT INTO schools (school, wins, games, players) VALUES (?, ?, 1, 1)
         ON CONFLICT (school) DO UPDATE SET wins = wins + excluded.wins, games = games + 1, players = players + ?`,
        p.school, win, existed ? 0 : 1,
      );
      this.sql.exec(
        `INSERT INTO weekly (week, school, nick, wins, games) VALUES (?, ?, ?, ?, 1)
         ON CONFLICT (week, school, nick) DO UPDATE SET wins = wins + excluded.wins, games = games + 1`,
        week, p.school, p.nick, win,
      );
    });
    this.cache.clear();
    this.statsCache = null;
    this.rankCache = null; // 방금 결과로 순위 칭호도 새로
    const rc2 = this.rankCtx();
    return results.map((p, i) => {
      const after = this.profile(p.school, p.nick, rc2);
      return {
        rpBefore: before[i].rp,
        rpAfter: after.rp,
        tierBefore: before[i].tier,
        tierAfter: after.tier,
        newTitles: after.titles.filter((t) => before[i].titles.indexOf(t) < 0),
        title: after.title,
      };
    });
  }

  // period: 'all'(전체) | 'week'(이번 주)
  // type: 'wins' | 'winrate' | 'school' | 'tier'(전체만)
  async ranking(type, period) {
    period = period === 'week' ? 'week' : 'all';
    const types = period === 'week' ? ['wins', 'winrate', 'school'] : ['wins', 'winrate', 'school', 'tier'];
    if (!types.includes(type)) type = 'wins';
    const cacheKey = `${period}:${type}`;
    const hit = this.cache.get(cacheKey);
    if (hit && Date.now() - hit.t < RANK_CACHE_MS) return hit.data;
    const week = weekKey();
    const minGames = period === 'week' ? WEEK_MIN_GAMES : MIN_GAMES_FOR_WINRATE;
    let rows;
    if (period === 'all') {
      const cols = 'school, nick, wins, games, rp';
      if (type === 'wins') {
        rows = this.sql.exec(`SELECT ${cols} FROM players WHERE wins > 0 ORDER BY wins DESC, games LIMIT 50`).toArray();
      } else if (type === 'winrate') {
        rows = this.sql.exec(
          `SELECT ${cols} FROM players WHERE games >= ${minGames}
           ORDER BY (CAST(wins AS REAL) / games) DESC, wins DESC LIMIT 50`,
        ).toArray();
      } else if (type === 'tier') {
        rows = this.sql.exec(`SELECT ${cols} FROM players WHERE games > 0 ORDER BY rp DESC, updated LIMIT 50`).toArray();
      } else {
        rows = this.sql.exec(
          'SELECT school, wins, games, players FROM schools WHERE wins > 0 ORDER BY wins DESC LIMIT 50',
        ).toArray();
      }
    } else if (type === 'school') {
      rows = this.sql.exec(
        `SELECT school, SUM(wins) AS wins, SUM(games) AS games, COUNT(*) AS players FROM weekly
         WHERE week = ? GROUP BY school HAVING SUM(wins) > 0 ORDER BY wins DESC LIMIT 50`, week,
      ).toArray();
    } else {
      const order = type === 'wins' ? 'w.wins DESC, w.games' : '(CAST(w.wins AS REAL) / w.games) DESC, w.wins DESC';
      const where = type === 'wins' ? 'w.wins > 0' : `w.games >= ${minGames}`;
      rows = this.sql.exec(
        `SELECT w.school, w.nick, w.wins, w.games, COALESCE(p.rp, 0) AS rp FROM weekly w
         LEFT JOIN players p ON p.school = w.school AND p.nick = w.nick
         WHERE w.week = ? AND ${where} ORDER BY ${order} LIMIT 50`, week,
      ).toArray();
    }
    // 학교 코드 → 학교 이름과 위치, 학생은 티어·대표 칭호도
    const idx = await loadSchools(this.env);
    const rc = this.rankCtx();
    for (const r of rows) {
      const sc = idx.byCode.get(r.school);
      r.schoolName = sc ? sc.name : '';
      r.place = sc ? placeOf(sc) : '';
      if (r.nick !== undefined) {
        const p = this.profile(r.school, r.nick, rc);
        r.tier = p.tier;
        r.title = p.title;
      }
    }
    const data = { type, period, week, minGames, rows };
    if (period === 'week') {
      // 지난주 챔피언 (이번 주 동안 '이번 주 챔피언' 칭호)
      const c = this.sql.exec(
        'SELECT school, nick, wins FROM weekly WHERE week = ? AND wins > 0 ORDER BY wins DESC, games LIMIT 1',
        weekKey(Date.now() - 7 * DAY_MS),
      ).toArray()[0];
      if (c) {
        const sc = idx.byCode.get(c.school);
        data.lastChampion = { nick: c.nick, wins: c.wins, schoolName: sc ? sc.name : '' };
      }
    }
    this.cache.set(cacheKey, { t: Date.now(), data });
    return data;
  }

  async me(schoolCode, nick) {
    const id = await checkIdentity(this.env, schoolCode, nick);
    if (id.error) return { found: false };
    const code = id.school.code;
    const p = this.profile(code, id.nick);
    if (!p.games) return { found: false, rp: 0, tier: 'bronze', titles: [], title: '' };
    const winsRank = p.wins > 0
      ? this.sql.exec('SELECT COUNT(*) AS n FROM players WHERE wins > ?', p.wins).one().n + 1
      : null;
    const sc = this.sql.exec('SELECT wins FROM schools WHERE school = ?', code).toArray()[0];
    const schoolRank = sc && sc.wins > 0
      ? this.sql.exec('SELECT COUNT(*) AS n FROM schools WHERE wins > ?', sc.wins).one().n + 1
      : null;
    const week = weekKey();
    const w = this.sql.exec(
      'SELECT wins, games FROM weekly WHERE week = ? AND school = ? AND nick = ?', week, code, id.nick,
    ).toArray()[0] || { wins: 0, games: 0 };
    const weekRank = w.wins > 0
      ? this.sql.exec('SELECT COUNT(*) AS n FROM weekly WHERE week = ? AND wins > ?', week, w.wins).one().n + 1
      : null;
    return {
      found: true,
      wins: p.wins,
      games: p.games,
      winsRank,
      schoolRank,
      schoolWins: sc ? sc.wins : 0,
      rp: p.rp,
      rpRank: p.rpRank,
      tier: p.tier,
      titles: p.titles,
      title: p.title,
      chosen: p.chosen,
      week: { wins: w.wins, games: w.games, rank: weekRank },
    };
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
      players: ps.map(({ a }) => ({
        id: a.id, name: a.nick, school: shortSchool(a.schoolName), ready: a.ready, host: a.id === m.hostId,
        tier: a.tier || 'bronze', title: a.title || '',
      })),
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
      id: m.id, title: m.title, host: host ? host.a.nick : '', hostTier: host ? host.a.tier || 'bronze' : '',
      count: ps.length, max: m.max, status: m.status,
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
      case 'emote': {
        // 상용구: 번호만 확인해서 다른 친구들에게 전달 (대기실·게임 중·결과 화면 모두)
        const i = Number(msg.i);
        if (!Number.isInteger(i) || i < 0 || i >= EMOTES.length) return;
        const now = Date.now();
        if (a.emAt && now - a.emAt < EMOTE_COOLDOWN_MS - 500) return; // 너무 자주 보내면 무시
        a.emAt = now;
        ws.serializeAttachment(a);
        this.broadcast('emote', { id: a.id, i }, ws);
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
    const id = await checkIdentity(this.env, msg.schoolCode, msg.nick);
    if (id.error) return this.fail(ws, id.error);
    const school = id.school.code, schoolName = id.school.name, nick = id.nick;
    // 이름표에 붙일 티어·대표 칭호
    let badge = { tier: 'bronze', title: '' };
    try { badge = await lobbyOf(this.env).badge(school, nick); } catch { /* 없어도 대결은 됨 */ }
    // (기다리는 동안 다른 친구가 들어왔을 수 있어 여기서 확인)
    if (m.status !== 'waiting') return this.fail(ws, '이미 게임 중인 방이에요.');
    const ps = this.players();
    if (ps.length >= m.max) return this.fail(ws, '방이 가득 찼어요.');
    if (ps.some((p) => p.a.school === school && p.a.nick === nick)) {
      return this.fail(ws, '같은 학교에 같은 닉네임인 친구가 이미 방에 있어요.');
    }
    const a = {
      id: m.nextPid++, school, schoolName, nick, ready: false, alive: false, joinedAt: Date.now(),
      tier: badge.tier, title: badge.title,
    };
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
    m.participants = ps.map(({ a: p }) => ({ id: p.id, school: p.school, nick: p.nick }));
    for (const p of ps) { p.a.alive = true; p.ws.serializeAttachment(p.a); }
    await this.save();
    this.broadcast('start', {
      seed: m.seed,
      players: ps.map(({ a: p }) => ({
        id: p.id, name: p.nick, school: shortSchool(p.schoolName), tier: p.tier || 'bronze', title: p.title || '',
      })),
    }, null, ps);
    this.broadcast('room', { room: this.info(ps) }, null, ps);
    await this.syncLobby(ps);
  }

  async checkEnd(exclude) {
    const m = this.meta;
    if (m.status !== 'playing') return;
    let ps = this.players(exclude);
    const alive = ps.filter((p) => p.a.alive);
    if (alive.length > 1) return;
    const winner = alive[0] ? alive[0].a : null;
    const seconds = (Date.now() - m.startedAt) / 1000;
    const participants = m.participants;
    const recorded = seconds >= MIN_GAME_SECONDS && participants.length >= 2;
    // 결과를 기록하는 동안(다른 곳에 물어보는 동안) 다른 친구의 탈락·나가기가 끼어들어도
    // 같은 판을 두 번 끝내지 않도록, 기록하기 전에 먼저 "게임 끝" 상태로 바꿈
    m.status = 'waiting';
    m.participants = [];
    for (const p of ps) {
      p.a.alive = false;
      p.a.ready = false;
      p.ws.serializeAttachment(p.a);
    }
    await this.save();
    // 플레이어 번호 → { 티어 점수 변화, 승급, 새 칭호 }
    const results = {};
    if (recorded) {
      // 중간에 나간 친구도 패배로 기록합니다.
      const out = await lobbyOf(this.env).recordResult(
        participants.map((p) => ({ school: p.school, nick: p.nick, win: !!winner && p.id === winner.id })),
      );
      participants.forEach((p, i) => { if (out[i]) results[p.id] = out[i]; });
      // 기다리는 동안 나간 친구가 있을 수 있어 다시 확인하고, 바뀐 티어·칭호를 이름표에 반영
      ps = this.players(exclude);
      for (const p of ps) {
        const r = results[p.a.id];
        if (r) { p.a.tier = r.tierAfter; p.a.title = r.title; p.ws.serializeAttachment(p.a); }
      }
    }
    this.broadcast('gameOver', {
      winnerId: winner ? winner.id : null, winner: winner ? winner.nick : null, recorded, results,
    }, null, ps);
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

  // 5분마다: 아무도 없으면 방을 정리하고, 있으면 로비에 살아 있다고 알림
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
