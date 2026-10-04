// 온라인 대결 서버 연결
export class Net {
  constructor() {
    this.ws = null;
    this.handlers = {};
    this.connected = false;
  }

  on(type, fn) { (this.handlers[type] ||= []).push(fn); }

  connect() {
    if (this.ws && this.ws.readyState <= 1) {
      return this.connected ? Promise.resolve() : new Promise((res, rej) => {
        this.ws.addEventListener('open', () => res(), { once: true });
        this.ws.addEventListener('error', () => rej(new Error('connect')), { once: true });
      });
    }
    return new Promise((resolve, reject) => {
      const proto = location.protocol === 'https:' ? 'wss' : 'ws';
      let ws;
      try {
        ws = new WebSocket(`${proto}://${location.host}/ws`);
      } catch (e) {
        reject(e);
        return;
      }
      this.ws = ws;
      let opened = false;
      ws.onopen = () => { opened = true; this.connected = true; resolve(); };
      ws.onerror = () => { if (!opened) reject(new Error('connect')); };
      ws.onclose = () => {
        this.connected = false;
        if (this.ws === ws) this.ws = null;
        if (opened) this.dispatch({ type: 'disconnected' });
      };
      ws.onmessage = (e) => {
        let m;
        try { m = JSON.parse(e.data); } catch { return; }
        this.dispatch(m);
      };
    });
  }

  dispatch(m) {
    for (const fn of this.handlers[m.type] || []) fn(m);
  }

  send(type, data = {}) {
    if (this.ws && this.ws.readyState === 1) this.ws.send(JSON.stringify({ type, ...data }));
  }
}
