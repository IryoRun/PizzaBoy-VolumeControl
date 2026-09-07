'use strict';
// Minimal Chrome DevTools Protocol client. Zero dependencies: uses Node's
// built-in fetch and WebSocket (Node >= 22).

const DEFAULT_PORT = 9222;

async function httpJson(port, path) {
  const res = await fetch(`http://127.0.0.1:${port}${path}`);
  if (!res.ok) throw new Error(`CDP HTTP ${res.status} for ${path}`);
  return res.json();
}

/** Poll until the debug endpoint answers, or time out. */
async function waitForEndpoint(port = DEFAULT_PORT, timeoutMs = 60000) {
  const deadline = Date.now() + timeoutMs;
  let lastErr;
  while (Date.now() < deadline) {
    try {
      return await httpJson(port, '/json/version');
    } catch (err) {
      lastErr = err;
      await new Promise((r) => setTimeout(r, 250));
    }
  }
  throw new Error(`No CDP endpoint on port ${port} after ${timeoutMs}ms: ${lastErr && lastErr.message}`);
}

/**
 * Find the game's page target. WebView2 briefly exposes an about:blank page
 * before it navigates to the game, and attaching to that one leaves us holding
 * a session that dies moments later -- so only accept a target that is
 * actually running index.html.
 */
function isGameTarget(t) {
  if (t.type !== 'page' || !t.webSocketDebuggerUrl) return false;
  const url = t.url || '';
  if (!url || url === 'about:blank') return false;
  return /index\.html/i.test(url) || /^https?:\/\/[^/]*\/?$/i.test(url);
}

async function findPageTarget(port = DEFAULT_PORT, timeoutMs = 60000) {
  const deadline = Date.now() + timeoutMs;
  let sawBlank = false;
  while (Date.now() < deadline) {
    let list = [];
    try {
      list = await httpJson(port, '/json/list');
    } catch { /* endpoint not ready yet */ }
    const page = list.find(isGameTarget);
    if (page) return page;
    if (list.some((t) => t.type === 'page')) sawBlank = true;
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error(
    `No game page target on port ${port}` +
    (sawBlank ? ' (only saw a blank WebView2 page -- did the game window open?)' : '')
  );
}

class CdpSession {
  constructor(wsUrl) {
    this.wsUrl = wsUrl;
    this.ws = null;
    this._nextId = 1;
    this._pending = new Map();
    this._listeners = new Map();
    this._closed = false;
  }

  connect() {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(this.wsUrl);
      this.ws = ws;
      ws.addEventListener('open', () => resolve(this));
      ws.addEventListener('error', () => {
        if (!this.ws || this.ws.readyState !== 1) reject(new Error('CDP websocket error'));
      });
      ws.addEventListener('close', () => {
        this._closed = true;
        for (const { reject: rj } of this._pending.values()) rj(new Error('CDP connection closed'));
        this._pending.clear();
        this._emit('__closed', {});
      });
      ws.addEventListener('message', (ev) => this._onMessage(ev.data));
    });
  }

  _onMessage(raw) {
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }
    if (msg.id !== undefined) {
      const p = this._pending.get(msg.id);
      if (!p) return;
      this._pending.delete(msg.id);
      if (msg.error) p.reject(new Error(`${msg.error.message} (code ${msg.error.code})`));
      else p.resolve(msg.result);
    } else if (msg.method) {
      this._emit(msg.method, msg.params || {});
    }
  }

  _emit(method, params) {
    const hs = this._listeners.get(method);
    if (hs) for (const h of [...hs]) h(params);
  }

  on(method, handler) {
    if (!this._listeners.has(method)) this._listeners.set(method, new Set());
    this._listeners.get(method).add(handler);
    return () => this._listeners.get(method).delete(handler);
  }

  send(method, params = {}) {
    if (this._closed) return Promise.reject(new Error('CDP connection closed'));
    const id = this._nextId++;
    return new Promise((resolve, reject) => {
      this._pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }

  /** Evaluate an expression in the page and return its value (awaits promises). */
  async evaluate(expression, { awaitPromise = true, returnByValue = true } = {}) {
    const res = await this.send('Runtime.evaluate', {
      expression,
      awaitPromise,
      returnByValue,
      allowUnsafeEvalBlockedByCSP: true,
      userGesture: true,
    });
    if (res.exceptionDetails) {
      const ex = res.exceptionDetails;
      const desc = (ex.exception && (ex.exception.description || ex.exception.value)) || ex.text;
      throw new Error(`Page exception: ${desc}`);
    }
    return res.result ? res.result.value : undefined;
  }

  close() {
    if (this.ws && !this._closed) this.ws.close();
  }
}

async function attach(port = DEFAULT_PORT, timeoutMs = 60000) {
  await waitForEndpoint(port, timeoutMs);
  const target = await findPageTarget(port, timeoutMs);
  const session = new CdpSession(target.webSocketDebuggerUrl);
  await session.connect();
  return { session, target };
}

module.exports = { attach, waitForEndpoint, findPageTarget, CdpSession, DEFAULT_PORT };
