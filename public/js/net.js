// 온라인 서버 연결 (로비용 하나, 대결방용 하나를 따로 씁니다)
export class Net {
  constructor() {
    this.ws = null;
    this.handlers = {};
    this.connected = false;
    this.pingTimer = null;
  }

  on(type, fn) { (this.handlers[type] = this.handlers[type] || []).push(fn); }

  connect(path) {
    this.close();
    return new Promise((resolve, reject) => {
      const proto = location.protocol === 'https:' ? 'wss' : 'ws';
      let ws;
      try {
        ws = new WebSocket(`${proto}://${location.host}${path}`);
      } catch (e) {
        reject(e);
        return;
      }
      this.ws = ws;
      let opened = false;
      ws.onopen = () => {
        opened = true;
        this.connected = true;
        // 연결 유지용. 서버가 깨어나지 않고 자동으로 답해서 요금이 들지 않아요.
        this.pingTimer = setInterval(() => { if (ws.readyState === 1) ws.send('ping'); }, 30000);
        resolve();
      };
      ws.onerror = () => { if (!opened) reject(new Error('connect')); };
      ws.onclose = () => {
        if (this.ws !== ws) return;
        clearInterval(this.pingTimer);
        this.connected = false;
        this.ws = null;
        if (opened) this.dispatch({ type: 'disconnected' });
      };
      ws.onmessage = (e) => {
        if (e.data === 'pong') return;
        let m;
        try { m = JSON.parse(e.data); } catch (_) { return; }
        this.dispatch(m);
      };
    });
  }

  close() {
    const ws = this.ws;
    this.ws = null;
    this.connected = false;
    clearInterval(this.pingTimer);
    if (ws) { try { ws.close(1000); } catch (_) { /* 무시 */ } }
  }

  dispatch(m) {
    for (const fn of this.handlers[m.type] || []) fn(m);
  }

  send(type, data = {}) {
    if (this.ws && this.ws.readyState === 1) this.ws.send(JSON.stringify(Object.assign({ type: type }, data)));
  }
}
