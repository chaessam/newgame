// 배경음악과 효과음 (아케이드 칩튠 스타일)
// 소리 파일 없이 브라우저의 Web Audio로 직접 만들어서, 내려받을 것도 저작권 걱정도 없습니다.
// 곡은 이 게임을 위해 새로 지은 멜로디입니다.

const store = {
  get(k) { try { return localStorage.getItem(k); } catch (_) { return null; } },
  set(k, v) { try { localStorage.setItem(k, v); } catch (_) { /* 저장 못 해도 괜찮음 */ } },
};

const midi = (n) => 440 * 2 ** ((n - 69) / 12);

// ---------------- 곡 ----------------
// 16분음표 16칸 = 1마디. lead/bass: [시작 칸, 음(MIDI), 길이(칸)]

// 배틀: 150 BPM, Am - F - C - G - Am - F - G - E
export const BATTLE = {
  bpm: 150,
  bars: 8,
  chords: [[69, 72, 76], [65, 69, 72], [72, 76, 79], [67, 71, 74], [69, 72, 76], [65, 69, 72], [67, 71, 74], [64, 68, 71]],
  roots: [45, 41, 48, 43, 45, 41, 43, 40],
  lead: [
    [[0, 76, 2], [2, 81, 2], [4, 79, 2], [6, 76, 2], [8, 72, 4], [12, 74, 2], [14, 76, 2]],
    [[0, 77, 3], [3, 76, 1], [4, 72, 4], [8, 69, 2], [10, 72, 2], [12, 77, 4]],
    [[0, 79, 2], [2, 76, 2], [4, 72, 2], [6, 76, 2], [8, 79, 4], [12, 81, 2], [14, 79, 2]],
    [[0, 74, 4], [4, 71, 2], [6, 74, 2], [8, 79, 6]],
    [[0, 81, 2], [2, 79, 2], [4, 76, 2], [6, 81, 2], [8, 84, 4], [12, 83, 2], [14, 81, 2]],
    [[0, 81, 2], [2, 77, 2], [4, 72, 2], [6, 77, 2], [8, 81, 4], [12, 79, 4]],
    [[0, 79, 2], [2, 74, 2], [4, 71, 2], [6, 74, 2], [8, 79, 2], [10, 81, 2], [12, 83, 4]],
    [[0, 83, 4], [4, 80, 4], [8, 76, 8]],
  ],
  drums: true,
};

// 메뉴: 112 BPM, C - Am - F - G, 반짝이는 아르페지오 위주
export const MENU = {
  bpm: 112,
  bars: 4,
  chords: [[72, 76, 79], [69, 72, 76], [65, 69, 72], [67, 71, 74]],
  roots: [48, 45, 41, 43],
  lead: [
    [[0, 84, 6], [6, 83, 2], [8, 79, 8]],
    [[0, 81, 6], [6, 79, 2], [8, 76, 8]],
    [[0, 77, 4], [4, 81, 4], [8, 84, 8]],
    [[0, 83, 4], [4, 79, 4], [8, 74, 6], [14, 79, 2]],
  ],
  drums: false,
};

class SoundEngine {
  constructor() {
    this.ctx = null;
    this.musicOn = store.get('gugu-music') !== 'off';
    this.sfxOn = store.get('gugu-sfx') !== 'off';
    this.want = null;     // 지금 틀어야 하는 곡 이름
    this.track = null;    // 지금 재생 중인 곡
    this.timer = null;
    this.step = 0;
    this.nextTime = 0;
    this.noise = null;
  }

  // 브라우저는 사용자가 화면을 한 번 누른 뒤에만 소리를 낼 수 있어요.
  unlock() {
    if (!this.ctx) {
      const AC = window.AudioContext || window.webkitAudioContext;
      if (!AC) return;
      this.ctx = new AC();
      this.master = this.ctx.createGain();
      this.master.gain.value = 0.9;
      this.master.connect(this.ctx.destination);
      this.musicBus = this.ctx.createGain();
      this.musicBus.gain.value = 0.16;
      this.musicBus.connect(this.master);
      this.sfxBus = this.ctx.createGain();
      this.sfxBus.gain.value = 0.32;
      this.sfxBus.connect(this.master);
      const len = this.ctx.sampleRate;
      this.noise = this.ctx.createBuffer(1, len, this.ctx.sampleRate);
      const d = this.noise.getChannelData(0);
      for (let i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;
    }
    if (this.ctx.state === 'suspended') this.ctx.resume();
    this.applyMusic();
  }

  setMusic(on) {
    this.musicOn = on;
    store.set('gugu-music', on ? 'on' : 'off');
    this.applyMusic();
  }

  setSfx(on) {
    this.sfxOn = on;
    store.set('gugu-sfx', on ? 'on' : 'off');
  }

  // 'menu' | 'battle' | null
  music(name) {
    this.want = name;
    this.applyMusic();
  }

  applyMusic() {
    const name = this.musicOn ? this.want : null;
    if (!this.ctx || name === this.track) return;
    this.stopMusic();
    if (!name) return;
    this.track = name;
    this.song = name === 'battle' ? BATTLE : MENU;
    this.step = 0;
    this.nextTime = this.ctx.currentTime + 0.08;
    this.timer = setInterval(() => this.schedule(), 25);
  }

  stopMusic() {
    clearInterval(this.timer);
    this.timer = null;
    this.track = null;
  }

  // 화면이 가려지면 소리를 멈췄다가 돌아오면 이어서
  pause(hidden) {
    if (!this.ctx) return;
    if (hidden) this.ctx.suspend();
    else { this.ctx.resume(); this.nextTime = this.ctx.currentTime + 0.05; }
  }

  schedule() {
    const ctx = this.ctx, song = this.song;
    const stepDur = 60 / song.bpm / 4;
    if (this.nextTime < ctx.currentTime - 0.2) this.nextTime = ctx.currentTime + 0.02; // 오래 멈췄다 돌아온 경우
    while (this.nextTime < ctx.currentTime + 0.12) {
      this.playStep(this.step, this.nextTime, stepDur);
      this.nextTime += stepDur;
      this.step = (this.step + 1) % (song.bars * 16);
    }
  }

  playStep(step, t, sd) {
    const song = this.song;
    const bar = Math.floor(step / 16), s = step % 16;
    const bus = this.musicBus;
    // 베이스: 8분음표, 뒷박은 한 옥타브 위
    if (s % 2 === 0) {
      const root = song.roots[bar] + (s % 4 === 2 && song.drums ? 12 : 0);
      this.tone('triangle', midi(root), t, sd * 1.8, 0.55, bus);
    }
    // 아르페지오: 16분음표로 화음을 오르내림
    const ch = song.chords[bar];
    const arp = [0, 1, 2, 1][s % 4];
    this.tone('square', midi(ch[arp] + (song.drums ? 0 : 12)), t, sd * 0.8, song.drums ? 0.12 : 0.1, bus);
    // 멜로디
    for (const [st, note, len] of song.lead[bar]) {
      if (st === s) this.tone('square', midi(note), t, sd * len * 0.92, song.drums ? 0.28 : 0.2, bus, 0.004);
    }
    // 드럼
    if (song.drums) {
      if (s === 0 || s === 8 || s === 10) this.kick(t, bus);
      if (s === 4 || s === 12) this.snare(t, bus);
      if (s % 2 === 1) this.hat(t, bus, s % 4 === 3 ? 0.18 : 0.1);
    } else if (s % 4 === 2) {
      this.hat(t, bus, 0.06);
    }
  }

  // ---------------- 소리 재료 ----------------

  tone(type, freq, t, dur, vol, dest, attack = 0.002, endFreq) {
    const ctx = this.ctx;
    const o = ctx.createOscillator();
    const g = ctx.createGain();
    o.type = type;
    o.frequency.setValueAtTime(freq, t);
    if (endFreq) o.frequency.exponentialRampToValueAtTime(endFreq, t + dur);
    g.gain.setValueAtTime(0.0001, t);
    g.gain.linearRampToValueAtTime(vol, t + attack);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    o.connect(g).connect(dest);
    o.start(t);
    o.stop(t + dur + 0.02);
  }

  noiseHit(t, dur, vol, dest, filterType, f1, f2) {
    const ctx = this.ctx;
    const src = ctx.createBufferSource();
    src.buffer = this.noise;
    const f = ctx.createBiquadFilter();
    f.type = filterType;
    f.frequency.setValueAtTime(f1, t);
    if (f2) f.frequency.exponentialRampToValueAtTime(f2, t + dur);
    const g = ctx.createGain();
    g.gain.setValueAtTime(vol, t);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    src.connect(f).connect(g).connect(dest);
    src.start(t, Math.random() * 0.5);
    src.stop(t + dur + 0.02);
  }

  kick(t, dest) { this.tone('sine', 150, t, 0.16, 0.9, dest, 0.001, 45); }
  snare(t, dest) { this.noiseHit(t, 0.12, 0.45, dest, 'highpass', 1500); }
  hat(t, dest, vol) { this.noiseHit(t, 0.04, vol, dest, 'highpass', 7000); }

  notes(type, list, gap, dur, vol, start = 0) {
    const t0 = this.ctx.currentTime + start;
    list.forEach((n, i) => this.tone(type, midi(n), t0 + i * gap, dur, vol, this.sfxBus));
  }

  // ---------------- 효과음 ----------------

  sfx(name, arg) {
    if (!this.sfxOn || !this.ctx || this.ctx.state !== 'running') return;
    const t = this.ctx.currentTime, b = this.sfxBus;
    switch (name) {
      case 'click': this.tone('square', 1200, t, 0.03, 0.12, b); break;
      case 'key': this.tone('square', 980, t, 0.035, 0.16, b); break;
      case 'move': this.tone('square', 700, t, 0.025, 0.1, b); break;
      case 'rotate': this.tone('square', 600, t, 0.05, 0.14, b, 0.002, 1100); break;
      case 'land': this.tone('triangle', 180, t, 0.09, 0.5, b, 0.001, 80); break;
      case 'question': this.notes('triangle', [88, 93], 0.09, 0.18, 0.4); break;
      case 'correct': this.notes('square', [84, 88, 91, 96], 0.06, 0.14, 0.26); break;
      case 'wrong':
        this.tone('sawtooth', 220, t, 0.14, 0.25, b, 0.002, 160);
        this.tone('sawtooth', 180, t + 0.15, 0.2, 0.25, b, 0.002, 110);
        break;
      case 'pop': {
        // 연쇄가 커질수록 높아지는 소리
        const n = Math.min(arg || 1, 10);
        const base = 72 + (n - 1) * 2;
        this.notes('square', [base, base + 4, base + 7, base + 12], 0.045, 0.1, 0.24);
        this.noiseHit(t, 0.15, 0.18, b, 'bandpass', 3000, 9000);
        break;
      }
      case 'attack': this.noiseHit(t, 0.35, 0.35, b, 'bandpass', 400, 4000); break;
      case 'incoming':
        this.tone('square', 330, t, 0.08, 0.2, b);
        this.tone('square', 330, t + 0.12, 0.08, 0.2, b);
        break;
      case 'garbage':
        this.noiseHit(t, 0.25, 0.5, b, 'lowpass', 600, 120);
        this.tone('sine', 110, t, 0.22, 0.5, b, 0.001, 50);
        break;
      case 'allclear': this.notes('square', [72, 76, 79, 84, 88, 91, 96], 0.06, 0.2, 0.24); break;
      case 'count': this.tone('square', 660, t, 0.12, 0.25, b); break;
      case 'go': this.notes('square', [84, 91], 0.07, 0.3, 0.28); break;
      case 'win': this.notes('square', [72, 76, 79, 84, 79, 84, 88], 0.11, 0.25, 0.28); break;
      case 'lose': this.notes('triangle', [76, 72, 67, 60], 0.18, 0.35, 0.4); break;
      case 'danger': this.tone('square', 990, t, 0.06, 0.12, b); break;
    }
  }
}

export const audio = new SoundEngine();
