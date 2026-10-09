import { PlayerGame, RemoteView } from './player.js';
import { CpuController, LEVELS, chainHint } from './ai.js';
import { drawBoard, drawNextPair, drawPending, drawDemoSlime, COLORS } from './render.js';
import { Net } from './net.js';
import { audio } from './audio.js';
import { normalizeNick, identityError, MIN_GAMES_FOR_WINRATE } from './identity.js';
import { hasProfanity } from './profanity.js';
import { SCHOOLS_PATH, indexSchools, searchSchools, countSameName, shortSchool, placeOf, currentSido } from './schools.js';
import { EMOTES, EMOTE_COOLDOWN_MS } from './emotes.js';
import { tierInfo, nextTier, MASTER_RP, GRANDMASTER_TOP, CHALLENGER_TOP } from './tiers.js';
import { TITLES, TITLE_GROUPS, titleInfo } from './titles.js';
import { nameplate, tierChip } from './badge.js';

const $ = (id) => document.getElementById(id);
const lobbyNet = new Net(); // 방 목록
const roomNet = new Net();  // 대결방

const store = {
  get(k) { try { return localStorage.getItem(k); } catch (_) { return null; } },
  set(k, v) { try { localStorage.setItem(k, v); } catch (_) { /* 저장 못 해도 괜찮음 */ } },
};

let match = null;
let myId = null;
let myName = '';
let currentRoom = null;
// 내 티어·대표 칭호 (내 기록을 불러오면 채워짐)
let myBadge = { tier: 'bronze', title: '', found: false };
let myMe = null; // /api/me 응답
let screen = 'menu';

// 상대에게 내 화면을 보내는 간격(초). 무료 플랜 요청 수를 아끼려고 꼭 필요할 때만 보내요.
// 내 게임은 내 기기에서 돌아가서, 이 값을 늘려도 내 화면은 전혀 느려지지 않아요.
const SEND_CHECK = 0.6;   // 판·점수·방해 슬라임이 바뀌었는지 확인하는 간격
const SEND_PAIR_ONLY = 2.5; // 떨어지는 슬라임 위치만 바뀌었을 때는 이만큼 기다렸다가 보냄

// ---------------- 화면 전환 / 알림 ----------------

function showScreen(name) {
  screen = name;
  if (name !== 'game') audio.music('menu');
  if (name === 'menu') loadStats();
  document.querySelectorAll('.screen').forEach((s) => s.classList.toggle('active', s.id === `screen-${name}`));
}

// ---------------- 창(칭호 도감·안내·QR) 열고 닫기 ----------------
// 휴대폰의 뒤로가기를 누르면 게임에서 나가지 않고 열린 창만 닫히도록 방문 기록에 한 칸 넣어 둠
const modalStack = [];
const modalClosedHooks = {};
function openModal(id) {
  if (modalStack.indexOf(id) >= 0) return;
  $(id).classList.add('show');
  modalStack.push(id);
  try { history.pushState({ gugupangModal: id }, ''); } catch (_) { /* 기록을 못 쓰면 버튼으로만 닫힘 */ }
}
function hideModal(id) {
  $(id).classList.remove('show');
  const i = modalStack.indexOf(id);
  if (i >= 0) modalStack.splice(i, 1);
  if (modalClosedHooks[id]) modalClosedHooks[id]();
}
function closeModal(id) {
  if (modalStack.indexOf(id) < 0) { $(id).classList.remove('show'); return; }
  // 넣어 둔 기록을 되돌리면 아래 popstate에서 창이 닫힘
  if (history.state && history.state.gugupangModal === id) history.back();
  else hideModal(id);
}
addEventListener('popstate', () => {
  const id = modalStack[modalStack.length - 1];
  if (id) hideModal(id);
});
// 창 바깥(어두운 곳)을 누르면 닫기
function closeOnBackdrop(id) {
  $(id).addEventListener('click', (e) => { if (e.target.id === id) closeModal(id); });
}

let toastTimer = null;
function toast(msg) {
  const t = $('toast');
  t.textContent = msg;
  t.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove('show'), 2600);
}

// 검색해서 고른 학교 { code, name, sido, addr }
let pickedSchool = null;
try { pickedSchool = JSON.parse(store.get('gugu-school-v2') || 'null'); } catch (_) { pickedSchool = null; }
// 통합 전 지역 이름(광주·전남)으로 저장해 둔 학교도 지금 이름으로 보여 줌 (학교 코드는 그대로)
if (pickedSchool) pickedSchool.sido = currentSido(pickedSchool.sido);

// 로그인 정보 { token, schoolCode, nick, school } — 같은 기기에서는 다음부터 자동으로 들어가짐
let auth = null;
try { auth = JSON.parse(store.get('gugu-auth') || 'null'); } catch (_) { auth = null; }
if (auth && (!auth.token || !auth.school)) auth = null;
if (auth) auth.school.sido = currentSido(auth.school.sido);

// 지금 들어와 있는 학생 (로그인 전이면 빈 값)
function identity() {
  if (!auth) return { schoolCode: '', school: null, nick: '' };
  return { schoolCode: auth.schoolCode, school: auth.school, nick: auth.nick };
}

function authHeaders(extra) {
  const h = Object.assign({}, extra || {});
  if (auth) h.Authorization = `Bearer ${auth.token}`;
  return h;
}

function saveIdentity() {
  store.set('gugu-school-v2', JSON.stringify(pickedSchool));
  store.set('gugu-name', $('name-input').value.trim());
}

// 게임을 시작하기 전: 들어와 있는지 확인
function readIdentity() {
  if (!auth) {
    toast('먼저 학교·닉네임·비밀번호를 적고 들어가기를 눌러 주세요.');
    $(pickedSchool ? ($('name-input').value.trim() ? 'pin-input' : 'name-input') : 'school-input').focus();
    return null;
  }
  myName = auth.nick;
  return identity();
}

// ---------------- 들어가기 (로그인) ----------------

function setAuth(a) {
  auth = a;
  store.set('gugu-auth', a ? JSON.stringify(a) : '');
  if (a) myName = a.nick;
  recordKey = '';
  updateLoginView();
  refreshMyRecord(true);
}

function updateLoginView() {
  $('login-box').hidden = !!auth;
}

async function doLogin(create) {
  saveIdentity();
  const nick = normalizeNick($('name-input').value);
  const id = { schoolCode: pickedSchool ? pickedSchool.code : '', nick };
  const err = identityError(id);
  if (err) {
    toast(err);
    $(err.startsWith('학교') ? 'school-input' : 'name-input').focus();
    return;
  }
  const pin = $('pin-input').value.trim();
  if (!/^[0-9]{4}$/.test(pin)) {
    toast('비밀번호는 숫자 4자리로 적어 주세요.');
    $('pin-input').focus();
    return;
  }
  const btn = $('btn-login');
  btn.disabled = true;
  let r;
  try {
    const res = await fetch('/api/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ schoolCode: id.schoolCode, nick, pin, create: !!create }),
    });
    r = await res.json();
  } catch (_) {
    r = { ok: false, error: '서버에 연결할 수 없어요.' };
  }
  btn.disabled = false;
  if (!r.ok && r.code === 'no_account') {
    const where = `${shortSchool(pickedSchool.name)} ${nick}`;
    const msg = r.hasRecord
      ? `"${where}" 기록이 있어요!\n이 비밀번호로 정하고 기록을 이어서 할까요?\n다음부터는 이 비밀번호로 들어와요. 꼭 기억해 주세요.`
      : `처음 오셨네요!\n"${where}" 계정을 이 비밀번호로 만들까요?\n비밀번호는 꼭 기억해 주세요.`;
    if (window.confirm(msg)) doLogin(true);
    return;
  }
  if (!r.ok) {
    toast(r.error || '들어가지 못했어요.');
    if (r.code === 'wrong_pin') { $('pin-input').value = ''; $('pin-input').focus(); }
    return;
  }
  $('pin-input').value = '';
  setAuth({ token: r.token, schoolCode: r.school, nick: r.nick, school: pickedSchool });
  toast(r.claimed ? `비밀번호를 정했어요. ${r.nick}의 기록이 그대로 이어져요!`
    : r.created ? `${r.nick} 계정을 만들었어요. 반가워요!` : `${r.nick}, 어서 와요!`);
}
$('btn-login').onclick = () => doLogin(false);
$('pin-input').addEventListener('keydown', (e) => { if (e.key === 'Enter') doLogin(false); });
// 비밀번호 칸에는 숫자만
$('pin-input').addEventListener('input', () => {
  const v = $('pin-input').value.replace(/[^0-9]/g, '').slice(0, 4);
  if (v !== $('pin-input').value) $('pin-input').value = v;
});

async function logout() {
  const token = auth && auth.token;
  setAuth(null);
  if (token) {
    try {
      await fetch('/api/logout', { method: 'POST', headers: { Authorization: `Bearer ${token}` } });
    } catch (_) { /* 이 기기에서는 이미 나감 */ }
  }
  toast('나갔어요. 다른 친구도 들어갈 수 있어요.');
}

if (matchMedia('(pointer: coarse)').matches || 'ontouchstart' in window) document.body.classList.add('touch');

// ---------------- 플레이어 패널 ----------------

// 연쇄 단계별 번쩍임 색 (render.js의 연쇄 글자 색과 같은 순서)
const CHAIN_GLOW = ['#ffe14d', '#ffe14d', '#ffb02e', '#ff6a3d', '#ff4fd8', '#b06bff', '#4ff0ff'];

class Panel {
  constructor(view, { cs, self = false, subtitle = '', school = '', tier = '', title = '' }) {
    this.view = view;
    this.cs = cs;
    const el = document.createElement('div');
    el.className = `panel${self ? ' self' : ''}${cs < 36 ? ' small' : ''}${cs <= 20 ? ' tiny' : ''}`;
    el.innerHTML = `
      <div class="panel-head">
        <div class="panel-who"><span class="panel-school"></span><div class="panel-name"></div></div>
        <div class="panel-next">
          <div class="nslot"><span>다음</span><canvas class="next1"></canvas></div>
          <div class="nslot second"><span>그다음</span><canvas class="next2"></canvas></div>
        </div>
      </div>
      <canvas class="pending"></canvas>
      <div class="board-frame"><canvas class="board"></canvas></div>
      <div class="panel-foot"><span>점수</span><span class="panel-score">0</span></div>
      <div class="panel-qtag"></div>`;
    el.querySelector('.panel-school').textContent = school;
    const nameEl = el.querySelector('.panel-name');
    if (tier) {
      // 티어 이름표 (롤 랭크처럼)
      nameEl.classList.add('has-np');
      // 내 판은 테두리로 이미 구분되니 "(나)"는 빼고 이름을 더 보여 줌
      nameEl.appendChild(nameplate(view.name, tier, { small: cs < 36 }));
      // 대표 칭호는 이름표가 잘리지 않게 아래 줄에 작게 (작은 판에서는 숨김)
      const ti = title ? titleInfo(title) : null;
      if (ti) {
        const tt = document.createElement('div');
        tt.className = `panel-title${ti.special ? ' admin-title' : ''}`;
        tt.textContent = `${ti.icon} ${ti.name}`;
        nameEl.after(tt);
      }
    } else {
      nameEl.textContent = view.name;
    }
    if (subtitle && !tier) {
      const s = document.createElement('small');
      s.textContent = subtitle;
      nameEl.appendChild(s);
    }
    this.el = el;
    this.board = el.querySelector('.board');
    this.next1 = el.querySelector('.next1');
    this.next2 = el.querySelector('.next2');
    this.pending = el.querySelector('.pending');
    this.scoreEl = el.querySelector('.panel-score');
    this.qtag = el.querySelector('.panel-qtag');
    this.self = self;
    this.lastScore = -1;
    this.lastPending = -1;
    this.lastNextKey = null; // null: 아직 한 번도 안 그림 (캔버스 크기를 꼭 맞추도록)
    this.seenPops = new WeakSet();
  }

  shake(chain) {
    const el = this.el;
    const px = Math.min(2 + chain * 1.5, 11) * (this.cs < 36 ? 0.6 : 1);
    el.style.setProperty('--sk', `${px}px`);
    el.style.setProperty('--glow', CHAIN_GLOW[Math.min(chain, CHAIN_GLOW.length - 1)]);
    el.classList.remove('chain-hit');
    void el.offsetWidth; // 애니메이션을 처음부터 다시
    el.classList.add('chain-hit');
    clearTimeout(this.shakeTimer);
    this.shakeTimer = setTimeout(() => el.classList.remove('chain-hit'), 600);
  }

  render() {
    const v = this.view;
    const cs = this.cs;
    drawBoard(this.board, v, cs);
    // 2연쇄부터 판이 흔들리고 테두리가 번쩍임 (연쇄가 클수록 세게)
    for (const pop of v.popups || []) {
      if (pop.kind !== 'chain' || pop.chain < 2 || this.seenPops.has(pop)) continue;
      this.seenPops.add(pop);
      this.shake(pop.chain);
    }
    const nk = v.nextPairs ? JSON.stringify(v.nextPairs) : '';
    if (nk !== this.lastNextKey) {
      const pairs = v.nextPairs || [];
      // 세로 화면에서는 다음 슬라임 상자를 작게 해서 판 위쪽 공간을 줄임
      const k = document.body.classList.contains('portrait') ? 0.8 : 1;
      drawNextPair(this.next1, pairs[0], Math.round(cs * 0.75 * k));
      drawNextPair(this.next2, pairs[1], Math.round(cs * 0.55 * k));
      this.lastNextKey = nk;
    }
    if (v.pendingIn !== this.lastPending) {
      drawPending(this.pending, v.pendingIn, cs);
      this.lastPending = v.pendingIn;
    }
    if (v.score !== this.lastScore) {
      this.scoreEl.textContent = String(v.score).padStart(8, '0');
      this.lastScore = v.score;
    }
    // 상대가 문제를 푸는 중이면 보드 위에 표시
    const showQ = !this.self && v.state === 'question' && v.question;
    this.qtag.classList.toggle('show', !!showQ);
    if (showQ) this.qtag.textContent = `${v.question.a} × ${v.question.b} 푸는 중...`;
  }
}

// ---------------- 곱셈 문제 입력 ----------------

const quiz = {
  input: '',
  game: null,
  show(game) {
    this.game = game;
    const q = game.question;
    this.input = '';
    $('q-a').textContent = q.a;
    $('q-b').textContent = q.b;
    this.setFeedback('');
    this.draw();
    setAsking(true);
  },
  hide() {
    setAsking(false);
    this.game = null;
  },
  active() { return !!(this.game && this.game.state === 'question'); },
  draw() { $('q-input').textContent = this.input || ' '; },
  setFeedback(text, kind = '') {
    const f = $('q-feedback');
    f.textContent = text;
    f.className = `q-feedback ${kind}`;
  },
  key(k) {
    if (!this.active()) return;
    if (k === 'del') this.input = this.input.slice(0, -1);
    else if (k === 'ok') return this.submit();
    else if (/^[0-9]$/.test(k) && this.input.length < 2) this.input = (this.input + k).replace(/^0+(?=\d)/, '');
    this.draw();
  },
  submit() {
    if (!this.active() || !this.input) return;
    const g = this.game;
    const q = g.question;
    const res = g.answer(Number(this.input));
    if (res === null) return;
    if (res) {
      this.setFeedback('정답! 펑!', 'good');
      setTimeout(() => { if (!this.active()) setAsking(false); }, 450);
      this.game = null;
      return;
    }
    this.input = '';
    this.draw();
    const box = $('qbox');
    box.classList.remove('shake');
    void box.offsetWidth;
    box.classList.add('shake');
    $('keypad').classList.add('locked');
    setTimeout(() => $('keypad').classList.remove('locked'), 2000);
    if (q.tries >= 2) {
      const hint = q.b > 1
        ? `힌트: ${q.a} × ${q.b - 1} = ${q.a * (q.b - 1)} 에 ${q.a}를 더하면?`
        : `힌트: 어떤 수에 1을 곱하면 그 수 그대로예요.`;
      this.setFeedback(hint, 'bad');
    } else {
      this.setFeedback('앗, 다시 생각해 봐요!', 'bad');
    }
  },
};

$('keypad').addEventListener('pointerdown', (e) => {
  const b = e.target.closest('button');
  if (!b) return;
  e.preventDefault();
  if (quiz.active()) audio.sfx('key');
  quiz.key(b.dataset.k);
});

// ---------------- 소리 ----------------

// 브라우저는 화면을 한 번 누르거나 키를 눌러야 소리를 낼 수 있어요.
for (const ev of ['pointerdown', 'keydown']) addEventListener(ev, () => audio.unlock(), true);
document.addEventListener('visibilitychange', () => audio.pause(document.hidden));
// 버튼 누르는 소리 (키패드·조작 버튼은 따로 처리)
document.addEventListener('click', (e) => { if (e.target.closest('.btn')) audio.sfx('click'); });

function updateSoundButtons() {
  const m = $('btn-music'), f = $('btn-sfx');
  m.textContent = audio.musicOn ? '🎵 음악' : '🎵 음악 꺼짐';
  f.textContent = audio.sfxOn ? '🔊 효과음' : '🔊 효과음 꺼짐';
  m.classList.toggle('off', !audio.musicOn);
  f.classList.toggle('off', !audio.sfxOn);
  m.setAttribute('aria-pressed', String(audio.musicOn));
  f.setAttribute('aria-pressed', String(audio.sfxOn));
  const anyOn = audio.musicOn || audio.sfxOn;
  $('btn-mute').textContent = anyOn ? '🔊' : '🔇';
  $('btn-mute').classList.toggle('off', !anyOn);
}
$('btn-music').onclick = () => { audio.unlock(); audio.setMusic(!audio.musicOn); updateSoundButtons(); };
$('btn-sfx').onclick = () => { audio.setSfx(!audio.sfxOn); updateSoundButtons(); };
// 게임 중: 음악·효과음을 한 번에 켜고 끄기
$('btn-mute').onclick = () => {
  const on = !(audio.musicOn || audio.sfxOn);
  audio.setSfx(on);
  audio.setMusic(on);
  updateSoundButtons();
};
updateSoundButtons();
audio.music('menu');

// ---------------- 연쇄 가이드 (혼자 연습) ----------------
let guideOn = store.get('gugu-guide') !== 'off';
function updateGuideButton() {
  const b = $('btn-guide');
  b.textContent = guideOn ? '💡 가이드' : '💡 꺼짐';
  b.classList.toggle('off', !guideOn);
  b.setAttribute('aria-pressed', String(guideOn));
}
$('btn-guide').onclick = () => {
  $('btn-guide').blur();
  guideOn = !guideOn;
  store.set('gugu-guide', guideOn ? 'on' : 'off');
  updateGuideButton();
  if (match && match.mode === 'solo') match.self.hint = guideOn ? chainHint(match.self.board, match.self.pair) : null;
  toast(guideOn ? '연쇄 가이드를 켰어요. 💡 표시가 있는 곳에 놓아 보세요!' : '연쇄 가이드를 껐어요.');
};

// ---------------- 한 판 진행 ----------------

class Match {
  constructor({ mode, level = 'normal', seed, players = [] }) {
    this.mode = mode;
    this.level = level;
    this.players = players;
    this.seed = seed != null ? seed : Math.floor(Math.random() * 2 ** 31);
    this.over = false;
    this.paused = false;
    this.countdown = 3.4;
    this.sendTimer = 0;
    this.lastSnap = '';
    this.lastPair = '';
    this.pairTimer = 0;
    this.opps = [];

    const self = new PlayerGame({ seed: this.seed, name: myName || '나' });
    this.self = self;
    self.on('question', () => { quiz.show(self); audio.sfx('question'); });
    self.on('dead', () => this.onSelfDead());
    self.on('lock', () => audio.sfx('land'));
    self.on('correct', () => audio.sfx('correct'));
    self.on('wrong', () => audio.sfx('wrong'));
    self.on('chain', (e) => {
      audio.sfx('pop', e.chain);
      if (e.chain >= 3) audio.sfx('bigchain', e.chain);
    });
    self.on('attack', () => audio.sfx('attack'));
    self.on('garbage', () => audio.sfx('garbage'));
    self.on('allclear', () => audio.sfx('allclear'));

    // 연쇄 가이드 (혼자 연습): 새 슬라임이 나올 때마다 연쇄가 터지는 자리를 찾아 둠
    if (mode === 'solo') {
      self.on('spawn', () => { self.hint = guideOn ? chainHint(self.board, self.pair) : null; });
      self.on('lock', () => { self.hint = null; });
    }

    if (mode === 'cpu') {
      const lv = LEVELS[level];
      const g = new PlayerGame({ seed: this.seed, name: `${lv.name} 로봇` });
      const ctrl = new CpuController(g, level, () => self.pendingIn);
      g.on('attack', (n) => { self.receiveGarbage(n); audio.sfx('incoming'); });
      self.on('attack', (n) => g.receiveGarbage(n));
      g.on('dead', () => { if (!self.isDead) this.finish(true); });
      this.opps.push({ id: 'cpu', game: g, view: g, ctrl, school: '컴퓨터' });
    } else if (mode === 'online') {
      for (const p of players) {
        if (p.id === myId) continue;
        const view = new RemoteView(p.name);
        // 모두 같은 순서의 슬라임을 받으므로, 첫 화면 정보가 오기 전에도 다음 슬라임을 보여 줄 수 있어요.
        view.nextPairs = self.nextPairs;
        this.opps.push({ id: p.id, view, school: p.school || '', tier: p.tier || 'bronze', title: p.title || '' });
      }
      self.on('attack', (n) => roomNet.send('attack', { n }));
    }

    this.buildDom();
  }

  buildDom() {
    quiz.hide();
    this.buildPanels();
    const label = this.mode === 'cpu' ? `컴퓨터 ${LEVELS[this.level].name}과 대결`
      : this.mode === 'solo' ? '혼자 연습' : `온라인 대결 · ${this.opps.length + 1}명`;
    $('mode-label').textContent = label;
    $('btn-emote').hidden = this.mode !== 'online';
    $('btn-guide').hidden = this.mode !== 'solo';
    updateGuideButton();
    showEmotePop(false);
    $('overlay-result').classList.remove('show');
    $('overlay-pause').classList.remove('show');
    $('overlay-countdown').classList.add('show');
    this.lastCount = null;
    this.render();
    requestAnimationFrame(fitArena);
  }

  // 보드 판 만들기. 세로 화면이면 상대 판을 작게 해서 내 판을 최대한 크게 보여 줍니다.
  buildPanels() {
    const portrait = isPortrait();
    this.portrait = portrait;
    $('self-slot').innerHTML = '';
    // 상대 판만 지움 (세로 화면에서는 그만하기 버튼도 이 칸에 들어 있음)
    $('opp-area').querySelectorAll('.panel').forEach((el) => el.remove());
    const mySchool = auth ? shortSchool(auth.school.name) : '';
    // 내 티어 이름표: 온라인이면 서버가 알려 준 값, 아니면 내 기록에서
    const meInfo = (this.players || []).find((p) => p.id === myId);
    const myTier = meInfo ? meInfo.tier : (auth ? myBadge.tier : '');
    const myTitle = meInfo ? meInfo.title : (auth ? myBadge.title : '');
    this.selfPanel = new Panel(this.self, {
      cs: 40, self: true, subtitle: '(나)', school: mySchool, tier: myTier, title: myTitle,
    });
    $('self-slot').appendChild(this.selfPanel.el);
    const n = this.opps.length;
    // 세로 화면에서는 상대 판을 작게 해서 내 판을 최대한 크게
    const ocs = portrait ? [15, 15, 13, 10][n] : [40, 40, 30, 24][n];
    const quit = $('game-tools');
    this.oppPanels = this.opps.map((o) => {
      const p = new Panel(o.view, { cs: ocs, school: o.school, tier: o.tier || '', title: o.title || '' });
      $('opp-area').insertBefore(p.el, quit.parentElement === $('opp-area') ? quit : null);
      return p;
    });
    // 세로 화면: 상대 판은 오른쪽에 세로로 쌓고, 그 아래 빈 곳에 그만하기 버튼
    $('opp-area').style.display = n ? '' : 'none';
    $('opp-area').classList.toggle('stack', portrait);
    this.render();
    requestAnimationFrame(fitArena);
  }

  start() {
    audio.music('battle');
    this.self.start();
    for (const o of this.opps) if (o.game) o.game.start();
  }

  update(dt) {
    if (this.paused) return;
    if (this.countdown > 0) {
      this.countdown -= dt;
      const n = Math.ceil(this.countdown - 0.4);
      const text = n > 0 ? String(n) : '시작!';
      if (text !== this.lastCount) {
        this.lastCount = text;
        audio.sfx(n > 0 ? 'count' : 'go');
        const el = $('countdown-text');
        el.textContent = text;
        el.style.animation = 'none';
        void el.offsetWidth;
        el.style.animation = '';
      }
      if (this.countdown <= 0) {
        $('overlay-countdown').classList.remove('show');
        this.start();
      }
      return;
    }
    input.update(dt);
    if (!this.over) this.self.update(dt);
    for (const o of this.opps) {
      if (o.game) {
        if (!this.over) { o.ctrl.update(dt); o.game.update(dt); }
      } else {
        o.view.update(dt);
      }
    }
    if (this.mode === 'online' && !this.over) {
      this.sendTimer -= dt;
      this.pairTimer -= dt;
      if (this.sendTimer <= 0) {
        this.sendTimer = SEND_CHECK;
        const snap = this.self.snapshot();
        const key = JSON.stringify(Object.assign({}, snap, { p: null }));
        const pairKey = JSON.stringify(snap.p);
        // 쌓인 판이 바뀌면 바로, 떨어지는 슬라임만 움직였으면 가끔씩
        if (key !== this.lastSnap || (pairKey !== this.lastPair && this.pairTimer <= 0)) {
          this.lastSnap = key;
          this.lastPair = pairKey;
          this.pairTimer = SEND_PAIR_ONLY;
          roomNet.send('state', { s: snap });
        }
      }
    }
    if (quiz.game === null && this.self.state === 'question' && !$('qbox').classList.contains('asking')) quiz.show(this.self);
  }

  render() {
    this.selfPanel.render();
    for (const p of this.oppPanels) p.render();
    const s = this.self.stats;
    const solved = s.correct + s.wrong;
    const rate = solved ? Math.round((s.correct / solved) * 100) : 0;
    const html = `푼 문제 <b>${s.correct}</b>개 · 정답률 <b>${rate}%</b><span class="lb"></span>최대 연쇄 <b>${s.maxChain}</b> · 보낸 방해 <b>${s.sent}</b>`;
    if (html !== this.lastStats) { $('mini-stats').innerHTML = html; this.lastStats = html; }
  }

  onSelfDead() {
    quiz.hide();
    if (this.mode === 'online') {
      roomNet.send('state', { s: this.self.snapshot() });
      roomNet.send('dead');
      // 탈락: 음악을 멈추고, 결과가 나오면 승패 소리는 다시 내지 않음
      audio.music(null);
      audio.sfx('lose');
      this.endSoundPlayed = true;
      if (!this.over) toast('탈락! 다른 친구들의 게임이 끝날 때까지 지켜봐요.');
      return;
    }
    if (this.mode === 'solo') return this.finish(null);
    this.finish(false);
  }

  remoteState(id, s) {
    const o = this.opps.find((x) => x.id === id);
    if (o) o.view.apply(s);
  }

  remoteDead(id) {
    const o = this.opps.find((x) => x.id === id);
    if (o) o.view.state = 'dead';
  }

  togglePause() {
    if (this.mode === 'online' || this.over || this.countdown > 0) return;
    this.paused = !this.paused;
    $('overlay-pause').classList.toggle('show', this.paused);
    audio.music(this.paused ? null : 'battle');
    if (!this.paused) input.reset();
  }

  // 컴퓨터 대결·혼자 연습 한 판을 첫 화면의 누적 대결 수에 더함 (끝난 판도, 도중에 나간 판도 한 번만)
  reportPlayed() {
    if (this.mode === 'online' || this.reported) return;
    this.reported = true;
    reportPlayed(this.mode, this.self.time);
  }

  // win: true 승리, false 패배, null 연습 종료
  // tierRes: 온라인 대결이 기록됐을 때 서버가 알려 준 내 티어 변화
  finish(win, winnerName, recorded, tierRes) {
    if (this.over) return;
    this.over = true;
    quiz.hide();
    audio.music(null);
    if (!this.endSoundPlayed) audio.sfx(win ? 'win' : 'lose');
    const s = this.self.stats;
    const solved = s.correct + s.wrong;
    const rate = solved ? Math.round((s.correct / solved) * 100) : 0;
    $('result-title').textContent = win === null ? '연습 끝!' : win ? '승리!' : '아쉬워요!';
    $('result-sub').textContent = win === null
      ? '구구단 실력이 쑥쑥 자라고 있어요.'
      : win ? '곱셈 연쇄 최고!'
        : winnerName ? `${winnerName} 친구가 이겼어요. 다시 도전해 봐요!` : '다시 도전해 봐요!';
    this.reportPlayed();
    if (this.mode === 'online') {
      $('result-sub').textContent += recorded ? ' (랭킹에 기록됐어요)' : ' (30초보다 짧은 판은 랭킹에 기록되지 않아요)';
      if (recorded) setTimeout(() => refreshMyRecord(true), 800);
    }
    $('result-stats').innerHTML = `
      <div><b>${this.self.score}</b><span>점수</span></div>
      <div><b>${s.maxChain}</b><span>최대 연쇄</span></div>
      <div><b>${s.correct}</b><span>맞힌 문제</span></div>
      <div><b>${rate}%</b><span>정답률</span></div>`;
    const btns = $('result-buttons');
    btns.innerHTML = '';
    const add = (text, cls, fn) => {
      const b = document.createElement('button');
      b.className = `btn ${cls}`;
      b.textContent = text;
      b.onclick = fn;
      btns.appendChild(b);
    };
    showTierResult(this.mode === 'online' ? tierRes : null);
    $('result-emotes').hidden = this.mode !== 'online';
    $('result-emote-log').innerHTML = '';
    if (this.mode === 'online') {
      add('대기실로', 'primary', () => { endMatch(); showScreen('room'); renderRoom(); });
      add('방 나가기', 'soft', () => { endMatch(); leaveRoomToLobby(); });
    } else {
      add('다시 하기', 'primary', () => startLocal(this.mode, this.level));
      add('메뉴로', 'soft', () => { endMatch(); showScreen('menu'); });
    }
    $('overlay-result').classList.add('show');
  }
}

// 결과 화면: 티어 점수 변화, 승급 연출, 새 칭호
function showTierResult(r) {
  const box = $('result-tier');
  box.innerHTML = '';
  box.hidden = !r;
  if (!r) return;
  const up = tierInfo(r.tierAfter).order > tierInfo(r.tierBefore).order;
  const down = tierInfo(r.tierAfter).order < tierInfo(r.tierBefore).order;
  if (up) {
    const promo = document.createElement('div');
    promo.className = `promo t-${r.tierAfter}`;
    promo.innerHTML = '<div class="promo-burst"></div>';
    promo.appendChild(tierChip(r.tierAfter));
    const txt = document.createElement('div');
    txt.className = 'promo-text';
    txt.textContent = `🎉 ${tierInfo(r.tierAfter).name} 승급!`;
    promo.appendChild(txt);
    box.appendChild(promo);
    audio.sfx('allclear');
  }
  const row = document.createElement('div');
  row.className = 'rt-row';
  row.appendChild(tierChip(r.tierAfter));
  const diff = r.rpAfter - r.rpBefore;
  const d = document.createElement('span');
  d.className = `rt-diff${diff > 0 ? ' plus' : diff < 0 ? ' minus' : ''}`;
  d.textContent = diff > 0 ? `+${diff}` : diff < 0 ? `${diff}` : '±0';
  const pts = document.createElement('span');
  pts.className = 'rt-rp';
  pts.textContent = `${r.rpAfter.toLocaleString('ko-KR')}점`;
  row.append(pts, d);
  box.appendChild(row);
  const nt = nextTier(r.rpAfter);
  const bar = document.createElement('div');
  bar.className = 'mt-bar';
  const fill = document.createElement('i');
  // 막대는 이전 점수에서 새 점수로 차오르게
  const before = nextTier(r.rpBefore);
  fill.style.width = `${Math.round(((before && !up && !down) ? before.progress : (nt ? 0 : 1)) * 100)}%`;
  bar.appendChild(fill);
  box.appendChild(bar);
  setTimeout(() => { fill.style.width = `${Math.round((nt ? nt.progress : 1) * 100)}%`; }, 250);
  const note = document.createElement('small');
  note.className = 'mt-note';
  note.textContent = nt ? `${nt.next.name}까지 ${nt.need}점`
    : diff === 0 && !r.rpBefore ? '' : '마스터 중 TOP 30은 그랜드마스터, TOP 10은 챌린저!';
  if (diff === 0 && r.rpBefore > 0 && !up) note.textContent = `강등 보호! ${tierInfo(r.tierAfter).name} 아래로는 떨어지지 않아요`;
  box.appendChild(note);
  for (const id of r.newTitles || []) {
    const ti = titleInfo(id);
    if (!ti) continue;
    const nt2 = document.createElement('div');
    nt2.className = 'new-title';
    nt2.textContent = `🎉 새 칭호: ${ti.icon} ${ti.name}`;
    box.appendChild(nt2);
  }
}

function endMatch() {
  // 그만하기·메뉴로·다시 하기로 나간 판도 셈 (이미 센 판은 다시 세지 않음)
  if (match) match.reportPlayed();
  match = null;
  showEmotePop(false);
  quiz.hide();
  input.reset();
  ['overlay-result', 'overlay-pause', 'overlay-countdown'].forEach((id) => $(id).classList.remove('show'));
}

// ---------------- 휴대폰 전체 화면 (주소창 숨기기) ----------------
// 안드로이드 브라우저는 버튼을 누를 때 전체 화면으로 바꿀 수 있어요. (아이폰 사파리는 지원하지 않음)
const fsTarget = document.documentElement;
const canFullscreen = !!(fsTarget.requestFullscreen || fsTarget.webkitRequestFullscreen);
const inKakao = /KAKAOTALK/i.test(navigator.userAgent);
const isFullscreen = () => !!(document.fullscreenElement || document.webkitFullscreenElement);

function enterFullscreen() {
  if (!document.body.classList.contains('touch') || !canFullscreen || isFullscreen()) return;
  try {
    const req = fsTarget.requestFullscreen || fsTarget.webkitRequestFullscreen;
    const p = req.call(fsTarget, { navigationUI: 'hide' });
    if (p && p.catch) p.catch(() => {});
  } catch (_) { /* 지원하지 않으면 그냥 넘어감 */ }
}

function exitFullscreen() {
  const exit = document.exitFullscreen || document.webkitExitFullscreen;
  try {
    const p = exit && exit.call(document);
    if (p && p.catch) p.catch(() => {});
  } catch (_) { /* 무시 */ }
}

function updateFullscreenButton() {
  const b = $('btn-fullscreen');
  b.hidden = !(document.body.classList.contains('touch') && canFullscreen);
  b.textContent = isFullscreen() ? '⛶ 전체 화면 끄기' : '⛶ 전체 화면';
}
$('btn-fullscreen').onclick = () => (isFullscreen() ? exitFullscreen() : enterFullscreen());
document.addEventListener('fullscreenchange', updateFullscreenButton);
document.addEventListener('webkitfullscreenchange', updateFullscreenButton);
updateFullscreenButton();

if (inKakao) {
  $('inapp-banner').hidden = false;
  $('btn-open-external').onclick = () => {
    location.href = `kakaotalk://web/openExternal?url=${encodeURIComponent(location.href)}`;
  };
}

function startLocal(mode, level) {
  endMatch();
  showScreen('game');
  match = new Match({ mode, level });
}

// 화면 크기에 맞게 게임판 확대/축소
// 세로 화면(휴대폰·세로 태블릿)이면 보드는 위에, 곱셈 창과 조작 버튼은 아래 dock으로
function isPortrait() {
  return innerHeight > innerWidth * 1.15 && innerWidth <= 900;
}

function fitArena() {
  const arena = $('arena');
  const fit = $('arena-fit');
  const portrait = isPortrait();
  document.body.classList.toggle('portrait', portrait);
  // 화면을 돌려서 가로/세로가 바뀌면 판 크기를 다시 정함
  if (match && match.portrait !== portrait) { match.buildPanels(); return; }
  const cc = $('center-col'), dock = $('dock'), tc = $('touch-controls');
  const quit = $('game-tools');
  if (portrait) {
    if (cc.parentElement !== dock) dock.prepend(cc);
    if (tc.parentElement !== dock) dock.appendChild(tc);
    // 상대가 있으면 상대 판 아래, 혼자 연습이면 조작 버튼 바로 위 오른쪽
    const solo = !match || !match.opps.length;
    const quitHome = solo ? $('dock-quit') : $('opp-area');
    if (quit.parentElement !== quitHome) quitHome.appendChild(quit);
  } else {
    if (cc.parentElement !== arena) arena.insertBefore(cc, $('opp-area'));
    if (tc.parentElement !== $('screen-game')) $('screen-game').insertBefore(tc, dock);
    if (quit.parentElement !== $('mini-row')) $('mini-row').appendChild(quit);
  }
  arena.style.transform = 'none';
  const w = arena.offsetWidth, h = arena.offsetHeight;
  if (portrait) {
    // 판은 위쪽에 최대한 크게, 남는 높이는 모두 아래 칸(조작 버튼·키패드)에 줌.
    // 아래 칸은 숫자 3개씩 4줄 키패드(1 2 3 / 4 5 6 / 7 8 9 / 지우기 0 확인)가 들어갈 만큼 남김.
    const pad = 4;
    const minDock = innerHeight >= 700 ? 190 : 170;
    const scale = Math.min((innerWidth - pad) / w, (innerHeight - minDock - pad) / h, 1.5);
    const dockH = Math.max(minDock, Math.floor(innerHeight - h * scale - pad));
    dock.style.height = `${dockH}px`;
    fit.style.bottom = `${dockH}px`;
    arena.style.transform = `scale(${scale})`;
    return;
  }
  dock.style.height = '';
  const bottom = document.body.classList.contains('touch') ? 84 : 0;
  fit.style.bottom = `${bottom}px`;
  const pad = 8;
  const scale = Math.min((innerWidth - pad) / w, (innerHeight - bottom - pad) / h, 1.5);
  arena.style.transform = `scale(${scale})`;
}

function setAsking(on) {
  $('qbox').classList.toggle('asking', on);
  document.body.classList.toggle('asking', on);
}
addEventListener('resize', () => { if (match) fitArena(); });

// ---------------- 조작 ----------------

const input = {
  dir: 0,
  t: 0,
  rep: 0,
  held: new Set(),
  game() { return match && !match.paused && match.countdown <= 0 && !match.over ? match.self : null; },
  press(dir) {
    const g = this.game();
    this.held.add(dir);
    this.dir = dir; this.t = 0; this.rep = 0;
    if (g && g.move(dir)) audio.sfx('move');
  },
  release(dir) {
    this.held.delete(dir);
    if (this.dir === dir) {
      this.dir = this.held.has(-dir) ? -dir : 0;
      this.t = 0; this.rep = 0;
    }
  },
  rotate(d) { const g = this.game(); if (g && g.rotate(d)) audio.sfx('rotate'); },
  soft(on) { const g = this.game(); if (g) g.setSoftDrop(on); else if (match) match.self.setSoftDrop(false); },
  update(dt) {
    const g = this.game();
    if (!g || !this.dir) return;
    this.t += dt;
    if (this.t < 0.16) return;
    this.rep += dt;
    while (this.rep >= 0.05) { g.move(this.dir); this.rep -= 0.05; }
  },
  reset() {
    this.held.clear(); this.dir = 0;
    if (match) match.self.setSoftDrop(false);
  },
};

addEventListener('keydown', (e) => {
  if (!match || screen !== 'game') return;
  const k = e.key;
  if (k === 'Escape') { match.togglePause(); return; }
  if (quiz.active()) {
    if (/^[0-9]$/.test(k)) { quiz.key(k); e.preventDefault(); return; }
    if (k === 'Backspace') { quiz.key('del'); e.preventDefault(); return; }
    if (k === 'Enter') { quiz.key('ok'); e.preventDefault(); return; }
  }
  if (['ArrowLeft', 'ArrowRight', 'ArrowDown', 'ArrowUp', ' '].includes(k)) e.preventDefault();
  if (e.repeat) return;
  if (k === 'ArrowLeft') input.press(-1);
  else if (k === 'ArrowRight') input.press(1);
  else if (k === 'ArrowDown') input.soft(true);
  else if (k === 'ArrowUp' || k === 'x' || k === 'X') input.rotate(1);
  else if (k === 'z' || k === 'Z') input.rotate(-1);
});

addEventListener('keyup', (e) => {
  if (!match) return;
  const k = e.key;
  if (k === 'ArrowLeft') input.release(-1);
  else if (k === 'ArrowRight') input.release(1);
  else if (k === 'ArrowDown') input.soft(false);
});

addEventListener('blur', () => input.reset());

for (const b of document.querySelectorAll('#touch-controls button')) {
  const t = b.dataset.t;
  const down = (e) => {
    e.preventDefault();
    b.classList.add('on');
    if (t === 'left') input.press(-1);
    else if (t === 'right') input.press(1);
    else if (t === 'down') input.soft(true);
    else if (t === 'cw') input.rotate(1);
    else if (t === 'ccw') input.rotate(-1);
  };
  const up = () => {
    b.classList.remove('on');
    if (t === 'left') input.release(-1);
    else if (t === 'right') input.release(1);
    else if (t === 'down') input.soft(false);
  };
  b.addEventListener('pointerdown', down);
  b.addEventListener('pointerup', up);
  b.addEventListener('pointercancel', up);
  b.addEventListener('pointerleave', up);
}

// ---------------- 메뉴 ----------------

$('name-input').value = store.get('gugu-name') || '';

// ---------------- 학교 검색 ----------------

let schoolIndex = null;
let schoolLoading = null;
function loadSchoolIndex() {
  if (schoolIndex) return Promise.resolve(schoolIndex);
  if (!schoolLoading) schoolLoading = fetch(SCHOOLS_PATH)
    .then((r) => { if (!r.ok) throw new Error(); return r.json(); })
    .then((d) => { schoolIndex = indexSchools(d); return schoolIndex; })
    .catch(() => { schoolLoading = null; return null; });
  return schoolLoading;
}

const schoolUi = {
  results: [],
  active: -1,
  showPicked() {
    const pick = $('school-pick');
    if (pickedSchool) {
      $('school-input').value = `${pickedSchool.name} (${placeOf(pickedSchool)})`;
      pick.classList.add('picked');
    } else {
      pick.classList.remove('picked');
    }
  },
  open(items) {
    const ul = $('school-results');
    ul.innerHTML = '';
    for (const item of items) ul.appendChild(item);
    ul.classList.toggle('show', items.length > 0);
    $('school-input').setAttribute('aria-expanded', String(items.length > 0));
  },
  close() { this.open([]); this.active = -1; },
  info(text) {
    const li = document.createElement('li');
    li.className = 'info';
    li.textContent = text;
    this.open([li]);
  },
  async search(q) {
    if (!q.trim()) return this.close();
    const idx = await loadSchoolIndex();
    if ($('school-input').value !== q) return; // 그사이 더 입력함
    if (!idx) return this.info('학교 목록을 불러올 수 없어요.');
    if (!idx.list.length) return this.info('학교 목록이 아직 준비되지 않았어요.');
    this.results = searchSchools(idx, q, 40);
    this.active = -1;
    if (!this.results.length) return this.info('찾는 학교가 없어요. 이름을 다시 확인해 주세요.');
    this.open(this.results.map((sc, i) => {
      const li = document.createElement('li');
      li.setAttribute('role', 'option');
      if (countSameName(idx, sc.name) > 1) li.className = 'dup';
      const name = document.createElement('span');
      name.textContent = sc.name;
      const place = document.createElement('small');
      place.textContent = placeOf(sc);
      li.append(name, place);
      li.addEventListener('pointerdown', (e) => { e.preventDefault(); this.pick(i); });
      return li;
    }));
  },
  pick(i) {
    const sc = this.results[i];
    if (!sc) return;
    pickedSchool = { code: sc.code, name: sc.name, sido: sc.sido, addr: sc.addr };
    saveIdentity();
    this.close();
    this.showPicked();
    $('school-input').blur();
    refreshMyRecord();
  },
  move(d) {
    const lis = [...$('school-results').querySelectorAll('li[role=option]')];
    if (!lis.length) return;
    this.active = (this.active + d + lis.length) % lis.length;
    lis.forEach((li, i) => li.classList.toggle('active', i === this.active));
    lis[this.active].scrollIntoView({ block: 'nearest' });
  },
};

let searchTimer = null;
$('school-input').addEventListener('input', () => {
  if (pickedSchool) {
    // 고른 학교를 지우고 새로 검색
    pickedSchool = null;
    saveIdentity();
    schoolUi.showPicked();
    refreshMyRecord();
  }
  clearTimeout(searchTimer);
  const q = $('school-input').value;
  searchTimer = setTimeout(() => schoolUi.search(q), 150);
});
$('school-input').addEventListener('focus', () => {
  loadSchoolIndex();
  if (pickedSchool) $('school-input').select();
});
$('school-input').addEventListener('blur', () => setTimeout(() => {
  schoolUi.close();
  if (!pickedSchool) $('school-input').value = '';
}, 150));
$('school-input').addEventListener('keydown', (e) => {
  if (e.key === 'ArrowDown') { e.preventDefault(); schoolUi.move(1); }
  else if (e.key === 'ArrowUp') { e.preventDefault(); schoolUi.move(-1); }
  else if (e.key === 'Enter') {
    e.preventDefault();
    schoolUi.pick(schoolUi.active >= 0 ? schoolUi.active : (schoolUi.results.length === 1 ? 0 : -1));
  } else if (e.key === 'Escape') schoolUi.close();
});
$('school-clear').addEventListener('click', () => {
  pickedSchool = null;
  saveIdentity();
  schoolUi.showPicked();
  $('school-input').value = '';
  $('school-input').focus();
  refreshMyRecord();
});
schoolUi.showPicked();

document.querySelectorAll('[data-cpu]').forEach((b) => {
  b.addEventListener('click', () => {
    if (!readIdentity()) return;
    enterFullscreen();
    startLocal('cpu', b.dataset.cpu);
  });
});
$('btn-solo').onclick = () => { if (readIdentity()) { enterFullscreen(); startLocal('solo'); } };
$('btn-howto').onclick = () => showScreen('howto');
$('btn-ranking').onclick = () => { saveIdentity(); showScreen('ranking'); loadRanking(rankType); };
document.querySelectorAll('[data-back]').forEach((b) => {
  b.addEventListener('click', () => {
    if (screen === 'lobby') lobbyNet.close();
    showScreen('menu');
    refreshMyRecord();
  });
});

$('btn-quit').onclick = () => {
  if (!match) return;
  if (match.mode === 'online') {
    if (!match.over && !match.self.isDead && !confirm('게임을 그만두고 방에서 나갈까요?')) return;
    endMatch();
    leaveRoomToLobby();
    return;
  }
  endMatch();
  showScreen('menu');
};
$('btn-resume').onclick = () => match && match.togglePause();
$('btn-pause-quit').onclick = () => { endMatch(); showScreen('menu'); };

// ---------------- 내 기록 ----------------

let recordTimer = null;
let recordKey = '', recordAt = 0;
// force: 방금 대결 결과가 기록됐을 때처럼 꼭 새로 받아야 할 때
async function refreshMyRecord(force = false) {
  const box = $('my-record');
  const id = identity();
  if (!auth) {
    box.innerHTML = '';
    recordKey = '';
    myMe = null;
    myBadge = { tier: 'bronze', title: '', found: false };
    return;
  }
  // 같은 사람 기록은 1분 안에 다시 묻지 않음 (무료 한도 아끼기)
  const key = `${id.schoolCode}/${id.nick}`;
  if (!force && key === recordKey && Date.now() - recordAt < 60000) return;
  recordKey = key;
  recordAt = Date.now();
  try {
    const res = await fetch('/api/me', { headers: authHeaders() });
    if (!res.ok) throw new Error();
    const r = await res.json();
    const cur = identity();
    if (cur.schoolCode !== id.schoolCode || cur.nick !== id.nick) return;
    if (!r.auth) {
      // 로그인 표시가 지워졌거나 오래됨 → 다시 들어가기
      setAuth(null);
      toast('다시 들어가 주세요. (비밀번호로 들어가기)');
      return;
    }
    renderMyRecord(r, id);
  } catch (_) {
    box.textContent = '';
    recordKey = '';
  }
}

// 홈 화면 내 기록: 티어 이름표 + 점수 막대 + 칭호 도감
function renderMyRecord(r, id) {
  const box = $('my-record');
  myMe = r;
  myBadge = { tier: r.tier || 'bronze', title: r.title || '', found: !!r.found };
  box.innerHTML = '';
  const card = document.createElement('div');
  card.className = `my-tier t-${myBadge.tier}`;
  const head = document.createElement('div');
  head.className = 'mt-head';
  head.appendChild(nameplate(id.nick, myBadge.tier, { title: myBadge.title }));
  const book = document.createElement('button');
  book.type = 'button';
  book.className = 'btn soft small mt-book';
  const got = (r.titles || []).length;
  book.textContent = `🏅 칭호 ${got}개`;
  book.onclick = () => openTitleBook();
  const out = document.createElement('button');
  out.type = 'button';
  out.className = 'btn soft small mt-out';
  out.textContent = '나가기';
  out.title = '다른 친구가 이 기기로 들어갈 때';
  out.onclick = () => { if (window.confirm(`${id.nick}에서 나갈까요?\n다음에 들어올 때 비밀번호가 필요해요.`)) logout(); };
  const btns = document.createElement('div');
  btns.className = 'mt-btns';
  btns.append(book, out);
  head.appendChild(btns);
  card.appendChild(head);

  const t = tierInfo(myBadge.tier);
  const isAdminCard = myBadge.tier === 'admin';
  const line = document.createElement('div');
  line.className = 'mt-line';
  const rp = r.rp || 0;
  line.innerHTML = `<b class="mt-tier">${t.name}</b> <span class="mt-rp">${rp.toLocaleString('ko-KR')}점</span>`;
  card.appendChild(line);
  const nt = nextTier(rp);
  const bar = document.createElement('div');
  bar.className = 'mt-bar';
  const fill = document.createElement('i');
  const note = document.createElement('small');
  note.className = 'mt-note';
  if (isAdminCard) {
    fill.style.width = '100%';
    note.textContent = '✨ 구구팡 슬라임 운영자 계정이에요';
  } else if (nt) {
    fill.style.width = `${Math.round(nt.progress * 100)}%`;
    note.textContent = `${nt.next.name}까지 ${nt.need}점`;
  } else {
    fill.style.width = '100%';
    note.textContent = r.rpRank
      ? `마스터 중 전국 ${r.rpRank}위 · TOP ${GRANDMASTER_TOP} 그랜드마스터, TOP ${CHALLENGER_TOP} 챌린저`
      : `${MASTER_RP}점 이상`;
  }
  bar.appendChild(fill);
  card.append(bar, note);

  const stats = document.createElement('div');
  stats.className = 'mt-stats';
  if (!r.found) {
    stats.textContent = `${shortSchool(id.school.name)} — 온라인 대결에서 이기면 티어 점수가 올라요 (승리 +25 · 패배 -10)`;
  } else {
    const rate = Math.round((r.wins / r.games) * 100);
    const parts = [`승리 <b>${r.wins}</b>`, `대결 <b>${r.games}</b>`, `승률 <b>${rate}%</b>`];
    if (r.week && r.week.games) parts.push(`이번 주 <b>${r.week.wins}</b>승`);
    if (r.winsRank) parts.push(`승리 랭킹 <b>${r.winsRank}</b>위`);
    if (r.schoolRank) parts.push(`우리 학교 <b>${r.schoolRank}</b>위`);
    // 항목 하나("우리 학교 5위")가 중간에서 끊겨 다음 줄로 넘어가지 않게, 항목 단위로만 줄바꿈
    stats.innerHTML = parts.map((x) => `<span class="mt-item">${x}</span>`).join('<span class="mt-sep"> · </span>');
  }
  card.appendChild(stats);
  box.appendChild(card);
}

// ---------------- 칭호 도감 ----------------

function openTitleBook() {
  const r = myMe || { titles: [], found: false };
  const earned = r.titles || [];
  const list = $('title-list');
  list.innerHTML = '';
  const normal = TITLES.filter((t) => !t.soon && !t.special);
  $('title-count').textContent = `${earned.filter((id) => normal.some((t) => t.id === id)).length} / ${normal.length}`;
  for (const g of TITLE_GROUPS) {
    // 특별 칭호(운영자)는 가진 사람에게만 보임
    const items = TITLES.filter((t) => t.group === g.id && (!t.special || earned.indexOf(t.id) >= 0));
    if (!items.length) continue;
    const h = document.createElement('h3');
    h.textContent = g.name;
    list.appendChild(h);
    const grid = document.createElement('div');
    grid.className = 'title-grid';
    for (const t of items) {
      const has = earned.indexOf(t.id) >= 0;
      const b = document.createElement('button');
      b.type = 'button';
      b.className = `title-card${has ? ' got' : ''}${t.soon ? ' soon' : ''}${r.title === t.id ? ' on' : ''}`;
      b.disabled = !has;
      b.innerHTML = '<span class="tc-icon"></span><span class="tc-name"></span><small class="tc-desc"></small>';
      b.querySelector('.tc-icon').textContent = has ? t.icon : '🔒';
      b.querySelector('.tc-name').textContent = t.name;
      b.querySelector('.tc-desc').textContent = t.soon ? `${t.desc} · 곧 열려요` : (t.rank ? `${t.desc} · 순위에서 밀리면 사라져요` : t.desc);
      if (has) b.onclick = () => chooseTitle(t.id);
      grid.appendChild(b);
    }
    list.appendChild(grid);
  }
  $('title-none').hidden = !earned.length;
  openModal('overlay-titles');
}

async function chooseTitle(titleId) {
  if (!auth) return;
  try {
    const res = await fetch('/api/title', {
      method: 'POST',
      headers: authHeaders({ 'Content-Type': 'application/json' }),
      body: JSON.stringify({ title: titleId }),
    });
    const r = await res.json();
    if (!r.ok) { toast(r.error || '칭호를 바꾸지 못했어요.'); return; }
    const ti = titleInfo(r.title);
    toast(ti ? `대표 칭호: ${ti.icon} ${ti.name}` : '칭호를 달지 않기로 했어요.');
  } catch (_) {
    toast('서버에 연결할 수 없어요.');
    return;
  }
  await refreshMyRecord(true);
  openTitleBook();
}
$('title-none').onclick = () => chooseTitle('none');
$('btn-titles-close').onclick = () => closeModal('overlay-titles');
closeOnBackdrop('overlay-titles');

$('name-input').addEventListener('input', () => {
  clearTimeout(recordTimer);
  recordTimer = setTimeout(saveIdentity, 500);
});
updateLoginView();
refreshMyRecord();

// ---------------- 친구에게 상용구 보내기 (온라인 대결) ----------------
// 대기실·게임 중·결과 화면 어디서나 보낼 수 있고, 받은 메시지는 "메시지 끄기"로 안 보이게 할 수 있어요.

let emotesOn = store.get('gugu-emote') !== 'off';
let emoteReadyAt = 0;

function playerName(id) {
  if (id === myId) return myName || '나';
  const p = currentRoom && currentRoom.players.find((q) => q.id === id);
  if (p) return p.name;
  const o = match && match.opps.find((q) => q.id === id);
  return o ? o.view.name : '친구';
}

function addEmoteLog(ul, name, text, max) {
  const li = document.createElement('li');
  const b = document.createElement('b');
  b.textContent = name;
  li.append(b, ` ${text}`);
  ul.appendChild(li);
  while (ul.children.length > max) ul.firstChild.remove();
}

// 보낸 친구의 판 위에 말풍선
function showBubble(id, text) {
  if (!match || screen !== 'game') return;
  let panel = null;
  if (id === myId) panel = match.selfPanel;
  else {
    const i = match.opps.findIndex((o) => o.id === id);
    if (i >= 0) panel = match.oppPanels[i];
  }
  if (!panel) return;
  const old = panel.el.querySelector('.panel-bubble');
  if (old) old.remove();
  const bubble = document.createElement('div');
  bubble.className = 'panel-bubble';
  bubble.textContent = text;
  panel.el.appendChild(bubble);
  setTimeout(() => bubble.remove(), 2500);
}

function showEmote(id, i) {
  const text = EMOTES[i];
  if (!text) return;
  const name = playerName(id);
  addEmoteLog($('room-emote-log'), name, text, 5);
  if ($('overlay-result').classList.contains('show')) addEmoteLog($('result-emote-log'), name, text, 3);
  showBubble(id, text);
}

function receiveEmote(id, i) {
  if (!emotesOn || id === myId) return;
  showEmote(id, i);
  audio.sfx('emote');
}

function sendEmote(i) {
  if (Date.now() < emoteReadyAt) return;
  emoteReadyAt = Date.now() + EMOTE_COOLDOWN_MS;
  roomNet.send('emote', { i });
  showEmote(myId, i);
  showEmotePop(false);
  // 잠깐 동안 버튼을 흐리게 해서 다시 보낼 수 없음을 알려 줌
  document.querySelectorAll('[data-emote-grid]').forEach((g) => g.classList.add('cooling'));
  setTimeout(() => {
    document.querySelectorAll('[data-emote-grid]').forEach((g) => g.classList.remove('cooling'));
  }, EMOTE_COOLDOWN_MS);
}

document.querySelectorAll('[data-emote-grid]').forEach((grid) => {
  EMOTES.forEach((text, i) => {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'emote-btn';
    b.textContent = text;
    // 버튼에 포커스가 남으면 Enter(정답 입력)가 이 버튼을 다시 누르게 되니 바로 풀어 줌
    b.onclick = () => { b.blur(); sendEmote(i); };
    grid.appendChild(b);
  });
});

function updateEmoteMute() {
  document.querySelectorAll('[data-emote-mute]').forEach((b) => {
    b.textContent = emotesOn ? '🔔 친구 메시지 켜짐' : '🔕 친구 메시지 꺼짐';
    b.classList.toggle('off', !emotesOn);
    b.setAttribute('aria-pressed', String(emotesOn));
  });
}
document.querySelectorAll('[data-emote-mute]').forEach((b) => {
  b.onclick = () => {
    b.blur();
    emotesOn = !emotesOn;
    store.set('gugu-emote', emotesOn ? 'on' : 'off');
    updateEmoteMute();
    toast(emotesOn ? '친구들의 메시지가 다시 보여요.' : '친구들의 메시지를 보이지 않게 했어요.');
  };
});
updateEmoteMute();

function showEmotePop(show) {
  $('emote-pop').hidden = !show;
  $('btn-emote').classList.toggle('on', show);
}
$('btn-emote').onclick = () => { $('btn-emote').blur(); showEmotePop($('emote-pop').hidden); };
$('emote-pop-close').onclick = () => showEmotePop(false);
// 고르는 창 바깥을 누르면 닫힘
document.addEventListener('pointerdown', (e) => {
  if ($('emote-pop').hidden) return;
  if (e.target.closest('#emote-pop') || e.target.closest('#btn-emote')) return;
  showEmotePop(false);
});

// ---------------- 업데이트 안내 · 개인정보처리방침 ----------------
// 새 안내가 생기면 NOTICE_VERSION을 바꾸면 기기마다 한 번 자동으로 떠요.
const NOTICE_VERSION = '2026-10-tier-login';
// 업데이트 안내는 어떻게 닫든(버튼·바깥·뒤로가기) 본 것으로 기억
modalClosedHooks['overlay-notice'] = () => store.set('gugu-notice', NOTICE_VERSION);
$('btn-notice').onclick = () => openModal('overlay-notice');
$('btn-notice-close').onclick = () => closeModal('overlay-notice');
$('btn-privacy').onclick = () => openModal('overlay-privacy');
$('btn-privacy-close').onclick = () => closeModal('overlay-privacy');
closeOnBackdrop('overlay-notice');
closeOnBackdrop('overlay-privacy');
if (store.get('gugu-notice') !== NOTICE_VERSION) openModal('overlay-notice');

// ---------------- QR 공유 ----------------

const SHARE_URL = 'https://gugupang.chaessam.workers.dev/';
$('btn-qr').onclick = () => openModal('overlay-qr');
$('btn-qr-close').onclick = () => closeModal('overlay-qr');
closeOnBackdrop('overlay-qr');
// Esc: 맨 위에 열린 창 닫기
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && modalStack.length) closeModal(modalStack[modalStack.length - 1]);
});
$('btn-qr-copy').onclick = async () => {
  try {
    await navigator.clipboard.writeText(SHARE_URL);
    toast('링크를 복사했어요. 학급 게시판이나 메신저에 붙여 넣어 주세요.');
  } catch (_) {
    toast(`복사가 안 되면 주소를 적어 주세요: ${SHARE_URL}`);
  }
};

// ---------------- 첫 화면 통계 ----------------

let statsLoadedAt = 0;
async function loadStats() {
  if (Date.now() - statsLoadedAt < 60000) return; // 1분에 한 번만 (무료 한도 아끼기)
  statsLoadedAt = Date.now();
  try {
    const res = await fetch('/api/stats');
    if (!res.ok) throw new Error();
    const r = await res.json();
    if (!r.schools && !r.games) return;
    $('stat-schools').textContent = r.schools.toLocaleString('ko-KR');
    $('stat-students').textContent = r.students.toLocaleString('ko-KR');
    $('stat-games').textContent = r.games.toLocaleString('ko-KR');
    $('play-stats').hidden = false;
  } catch (_) {
    statsLoadedAt = 0;
  }
}
loadStats();

// 게임 도중에 창을 닫거나 다른 주소로 가도 셈
addEventListener('pagehide', () => { if (match) match.reportPlayed(); });

// 컴퓨터 대결·혼자 연습 한 판을 누적 대결 수에 더함 (너무 짧은 판은 빼요)
function reportPlayed(mode, seconds) {
  if (seconds < 20) return;
  const body = { mode };
  if (auth) body.token = auth.token;
  statsLoadedAt = 0; // 메뉴로 돌아가면 바로 새 숫자를 보여 줌
  const json = JSON.stringify(body);
  // sendBeacon은 창을 닫는 중에도 브라우저가 끝까지 보내 줌
  try {
    if (navigator.sendBeacon && navigator.sendBeacon('/api/played', json)) return;
  } catch (_) { /* 아래 방법으로 */ }
  fetch('/api/played', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: json,
    keepalive: true,
  }).catch(() => {});
}

// ---------------- 랭킹 ----------------

let rankType = 'wins';
let rankPeriod = 'all';
document.querySelectorAll('#rank-tabs button').forEach((b) => {
  b.addEventListener('click', () => loadRanking(b.dataset.rank));
});
document.querySelectorAll('#rank-period button').forEach((b) => {
  b.addEventListener('click', () => {
    rankPeriod = b.dataset.period;
    // 티어는 전체 랭킹에만 있음
    loadRanking(rankPeriod === 'week' && rankType === 'tier' ? 'wins' : rankType);
  });
});

async function loadRanking(type) {
  rankType = type;
  const period = rankPeriod;
  document.querySelectorAll('#rank-period button').forEach((b) => b.classList.toggle('on', b.dataset.period === period));
  document.querySelectorAll('#rank-tabs button').forEach((b) => {
    b.classList.toggle('on', b.dataset.rank === type);
    b.hidden = period === 'week' && b.dataset.rank === 'tier';
  });
  const ul = $('rank-list');
  const note = $('rank-note');
  const week = period === 'week';
  note.textContent = type === 'tier' ? `온라인 대결 티어 점수 순위예요. 마스터(${MASTER_RP}점) 중 TOP ${GRANDMASTER_TOP}은 그랜드마스터, TOP ${CHALLENGER_TOP}은 챌린저!`
    : type === 'winrate' ? `대결을 ${week ? 5 : MIN_GAMES_FOR_WINRATE}판 이상 한 친구만 승률 랭킹에 올라요.`
      : type === 'school' ? '학교 친구들의 승리 횟수를 모두 더한 순위예요.'
        : '온라인 대결에서 이긴 횟수 순위예요.';
  if (week) note.textContent += ' 매주 월요일 0시에 새로 시작해요.';
  ul.innerHTML = '<li class="empty">불러오는 중...</li>';
  let data;
  try {
    const res = await fetch(`/api/rank?type=${type}&period=${period}`);
    if (!res.ok) throw new Error();
    data = await res.json();
  } catch (_) {
    ul.innerHTML = '<li class="empty">랭킹 서버에 연결할 수 없어요.</li>';
    return;
  }
  if (rankType !== type || rankPeriod !== period) return;
  if (data.minGames && type === 'winrate') {
    note.textContent = note.textContent.replace(/\d+판 이상/, `${data.minGames}판 이상`);
  }
  ul.innerHTML = '';
  if (week && data.lastChampion) {
    const c = document.createElement('li');
    c.className = 'champ';
    c.textContent = `🏆 지난주 챔피언: ${data.lastChampion.nick} (${shortSchool(data.lastChampion.schoolName)}) · ${data.lastChampion.wins}승`;
    ul.appendChild(c);
  }
  if (!data.rows.length) {
    const li = document.createElement('li');
    li.className = 'empty';
    li.textContent = week ? '이번 주에는 아직 기록이 없어요. 첫 번째 주인공이 되어 보세요!' : '아직 기록이 없어요. 첫 번째 주인공이 되어 보세요!';
    ul.appendChild(li);
    return;
  }
  const me = identity();
  data.rows.forEach((r, i) => {
    const li = document.createElement('li');
    const isMe = type === 'school'
      ? r.school === me.schoolCode
      : r.school === me.schoolCode && r.nick === me.nick;
    li.className = `${isMe ? 'me' : ''}${i < 3 ? ` top${i + 1}` : ''}`;
    const rk = document.createElement('span');
    rk.className = 'rk';
    rk.textContent = i + 1;
    const who = document.createElement('div');
    who.className = 'who';
    const top = document.createElement('div');
    const sub = document.createElement('small');
    if (type === 'school') {
      top.textContent = r.schoolName || '(학교 정보 없음)';
      sub.textContent = `${r.place} · 참여 ${r.players}명`;
    } else {
      top.appendChild(nameplate(r.nick, r.tier || 'bronze', { title: r.title }));
      sub.textContent = `${shortSchool(r.schoolName)} · ${r.place}`;
    }
    who.append(top, sub);
    const val = document.createElement('div');
    val.className = 'val';
    const big = document.createElement('b');
    const small = document.createElement('small');
    const rate = Math.round((r.wins / r.games) * 100);
    if (type === 'tier') {
      big.textContent = `${(r.rp || 0).toLocaleString('ko-KR')}점`;
      small.textContent = `${tierInfo(r.tier).name} · ${r.wins}승`;
    } else if (type === 'winrate') {
      big.textContent = `${rate}%`;
      small.textContent = `${r.wins}승 / ${r.games}판`;
    } else {
      big.textContent = `${r.wins}승`;
      small.textContent = type === 'school' ? `${r.games}판` : `승률 ${rate}%`;
    }
    val.append(big, small);
    li.append(rk, who, val);
    ul.appendChild(li);
  });
}

// ---------------- 온라인 ----------------

async function enterLobby() {
  roomNet.close();
  currentRoom = null;
  myId = null;
  const id = identity();
  $('lobby-me').textContent = `${shortSchool(id.school.name)} · ${id.nick}`;
  $('lobby-status').textContent = '서버에 연결하는 중...';
  $('room-list').innerHTML = '';
  showScreen('lobby');
  try {
    await lobbyNet.connect('/ws/lobby');
    lobbyNet.send('hello');
  } catch (_) {
    $('lobby-status').textContent = '온라인 서버에 연결할 수 없어요. 인터넷 연결을 확인해 주세요.';
  }
}

function leaveRoomToLobby() {
  roomNet.send('leave');
  roomNet.close();
  enterLobby();
}

async function joinRoom(roomId) {
  const id = identity();
  lobbyNet.close();
  try {
    await roomNet.connect(`/ws/room/${roomId}`);
    roomNet.send('join', { token: auth ? auth.token : '' });
  } catch (_) {
    toast('방에 들어갈 수 없어요.');
    enterLobby();
  }
}

$('btn-online').onclick = () => { if (readIdentity()) { enterFullscreen(); enterLobby(); } };

$('btn-create-room').onclick = () => {
  if (!lobbyNet.connected) return toast('서버에 연결되어 있지 않아요.');
  if (hasProfanity($('room-title').value)) return toast('방 이름에 사용할 수 없는 말이 들어 있어요.');
  lobbyNet.send('createRoom', { title: $('room-title').value, max: $('room-max').value, name: myName });
  $('room-title').value = '';
};
$('room-title').addEventListener('keydown', (e) => { if (e.key === 'Enter') $('btn-create-room').click(); });

$('btn-ready').onclick = () => {
  if (!currentRoom) return;
  const me = currentRoom.players.find((p) => p.id === myId);
  roomNet.send('ready', { ready: !(me && me.ready) });
};
$('btn-start').onclick = () => roomNet.send('start');
$('btn-leave-room').onclick = () => leaveRoomToLobby();

function renderRooms(list) {
  const ul = $('room-list');
  ul.innerHTML = '';
  $('lobby-status').textContent = '';
  if (!list.length) {
    const li = document.createElement('li');
    li.className = 'empty';
    li.textContent = '아직 만들어진 방이 없어요. 첫 번째 방을 만들어 보세요!';
    ul.appendChild(li);
    return;
  }
  for (const r of list) {
    const li = document.createElement('li');
    const title = document.createElement('div');
    title.className = 'r-title';
    title.textContent = r.title;
    const host = document.createElement('span');
    host.className = 'r-host';
    host.append('방장 ');
    if (r.host) host.appendChild(nameplate(r.host, r.hostTier || 'bronze', { small: true }));
    else host.append('-');
    title.appendChild(host);
    const count = document.createElement('span');
    count.className = 'r-count';
    count.textContent = `${r.count} / ${r.max}명`;
    li.append(title, count);
    if (r.status === 'playing') {
      const badge = document.createElement('span');
      badge.className = 'r-badge';
      badge.textContent = '게임 중';
      li.appendChild(badge);
    } else {
      const btn = document.createElement('button');
      btn.className = 'btn primary';
      btn.textContent = r.count >= r.max ? '가득 참' : '들어가기';
      btn.disabled = r.count >= r.max;
      btn.onclick = () => joinRoom(r.id);
      li.appendChild(btn);
    }
    ul.appendChild(li);
  }
}

function renderRoom() {
  const r = currentRoom;
  if (!r) return;
  $('room-title-text').textContent = r.title;
  $('room-sub').textContent = `${r.players.length} / ${r.max}명 · ${r.status === 'playing' ? '게임 중' : '기다리는 중'}`;
  const ul = $('room-players');
  ul.innerHTML = '';
  r.players.forEach((p, i) => {
    const li = document.createElement('li');
    const dot = document.createElement('span');
    dot.className = 'p-dot';
    dot.style.background = COLORS[i % COLORS.length].main;
    const name = document.createElement('span');
    name.className = 'p-name';
    name.appendChild(nameplate(p.name, p.tier || 'bronze', { title: p.title, suffix: p.id === myId ? '(나)' : '' }));
    const school = document.createElement('span');
    school.className = 'p-school';
    school.textContent = p.school || '';
    name.appendChild(school);
    const tag = document.createElement('span');
    tag.className = `p-tag${p.host ? ' host' : p.ready ? ' ready' : ''}`;
    tag.textContent = p.host ? '방장' : p.ready ? '준비 완료' : '기다리는 중';
    li.append(dot, name, tag);
    ul.appendChild(li);
  });
  const isHost = r.hostId === myId;
  const me = r.players.find((p) => p.id === myId);
  $('btn-ready').style.display = isHost ? 'none' : '';
  $('btn-ready').textContent = me && me.ready ? '준비 취소' : '준비 완료';
  $('btn-start').style.display = isHost ? '' : 'none';
  const allReady = r.players.every((p) => p.host || p.ready);
  $('btn-start').disabled = r.players.length < 2 || !allReady || r.status !== 'waiting';
  $('room-status').textContent = r.status === 'playing' ? '게임이 진행 중이에요.'
    : r.players.length < 2 ? '친구가 들어오기를 기다리고 있어요...'
      : isHost ? (allReady ? '모두 준비됐어요! 게임 시작을 눌러요.' : '친구들이 준비 완료를 누르길 기다려요.')
        : (me && me.ready ? '방장이 시작하길 기다려요.' : '준비가 되면 준비 완료를 눌러요.');
}

lobbyNet.on('rooms', (m) => { if (screen === 'lobby') renderRooms(m.rooms); });
lobbyNet.on('roomCreated', (m) => joinRoom(m.id));
lobbyNet.on('disconnected', () => {
  if (screen === 'lobby') $('lobby-status').textContent = '서버 연결이 끊어졌어요. 메뉴로 갔다가 다시 들어와 주세요.';
});

roomNet.on('joined', (m) => {
  myId = m.you;
  $('room-emote-log').innerHTML = '';
  currentRoom = m.room;
  if (screen !== 'game') showScreen('room');
  renderRoom();
});
roomNet.on('room', (m) => {
  if (!currentRoom || currentRoom.id !== m.room.id) return;
  currentRoom = m.room;
  renderRoom();
});
roomNet.on('error', (m) => {
  toast(m.message);
  if (m.fatal) { roomNet.close(); enterLobby(); }
});
roomNet.on('start', (m) => {
  endMatch();
  showScreen('game');
  match = new Match({ mode: 'online', seed: m.seed, players: m.players });
});
roomNet.on('state', (m) => { if (match && match.mode === 'online') match.remoteState(m.id, m.s); });
roomNet.on('attack', (m) => {
  if (!match || match.mode !== 'online' || match.over) return;
  match.self.receiveGarbage(m.n);
  audio.sfx('incoming');
});
roomNet.on('emote', (m) => receiveEmote(m.id, m.i));
roomNet.on('playerDead', (m) => { if (match && match.mode === 'online') match.remoteDead(m.id); });
roomNet.on('gameOver', (m) => {
  if (!match || match.mode !== 'online') return;
  match.finish(m.winnerId === myId, m.winner, m.recorded, m.results ? m.results[myId] : null);
});
roomNet.on('disconnected', () => {
  currentRoom = null;
  if (match && match.mode === 'online') endMatch();
  if (['room', 'game'].includes(screen)) {
    toast('방 연결이 끊어졌어요.');
    enterLobby();
  }
});

// ---------------- 메뉴 장식 & 메인 루프 ----------------

function drawLogo() {
  const box = $('logo-slimes');
  box.innerHTML = '';
  [[0, 7], [1, 8], [2, 5], [3, 6], [4, 9]].forEach(([c, n]) => {
    const cv = document.createElement('canvas');
    drawDemoSlime(cv, c, n, 52);
    box.appendChild(cv);
  });
}
drawLogo();
if (document.fonts && document.fonts.ready) document.fonts.ready.then(drawLogo);

let last = performance.now();
function frame(now) {
  const dt = Math.min(0.05, (now - last) / 1000);
  last = now;
  if (match) {
    match.update(dt);
    match.render();
  }
  requestAnimationFrame(frame);
}
requestAnimationFrame(frame);

// 여기까지 왔으면 모든 파일을 문제없이 읽은 것 (index.html의 안전장치가 확인)
// 서버 응답(통계·내 기록)은 기다리지 않음: 학교 와이파이가 느려도 정상 기기에 안내 화면이 뜨지 않게
window.__gameReady = true;
