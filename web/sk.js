// serial-klipper wire protocol + channel multiplexer (browser port of serial_klipper/proto.py + mux.py)
export const T = { HELLO: 1, OPEN: 2, OPENED: 3, DATA: 4, ACK: 5, CLOSE: 6 };
export const MAX_PAYLOAD = 1024;
export const WINDOW = 16384;

export function crc16(bytes, crc = 0xFFFF) {
  for (let i = 0; i < bytes.length; i++) {
    crc ^= bytes[i] << 8;
    for (let b = 0; b < 8; b++) crc = (crc & 0x8000) ? ((crc << 1) ^ 0x1021) & 0xFFFF : (crc << 1) & 0xFFFF;
  }
  return crc;
}

export function cobsEncode(data) {
  const out = [];
  let block = [];
  for (const b of data) {
    if (b === 0) {
      out.push(block.length + 1, ...block);
      block = [];
    } else {
      block.push(b);
      if (block.length === 254) {
        out.push(255, ...block);
        block = [];
      }
    }
  }
  out.push(block.length + 1, ...block);
  return Uint8Array.from(out);
}

export function cobsDecode(data) {
  const out = [];
  let i = 0;
  const n = data.length;
  while (i < n) {
    const code = data[i];
    if (code === 0 || i + code > n) throw new Error("bad COBS block");
    for (let j = 1; j < code; j++) out.push(data[i + j]);
    i += code;
    if (code !== 255 && i < n) out.push(0);
  }
  return Uint8Array.from(out);
}

export function encodeFrame(type, chan, payload = new Uint8Array(0)) {
  const body = new Uint8Array(5 + payload.length);
  body[0] = type;
  body[1] = chan & 255;
  body[2] = chan >> 8;
  body.set(payload, 3);
  const crc = crc16(body.subarray(0, 3 + payload.length));
  body[3 + payload.length] = crc & 255;
  body[4 + payload.length] = crc >> 8;
  const enc = cobsEncode(body);
  const out = new Uint8Array(enc.length + 1);
  out.set(enc);
  return out;
}

export function decodeFrame(raw) {
  const body = cobsDecode(raw);
  if (body.length < 5) throw new Error("short frame");
  const end = body.length - 2;
  if (crc16(body.subarray(0, end)) !== (body[end] | (body[end + 1] << 8))) throw new Error("crc mismatch");
  return { type: body[0], chan: body[1] | (body[2] << 8), payload: body.subarray(3, end) };
}

export class Decoder {
  constructor() { this.buf = []; this.errors = 0; }
  *feed(data) {
    for (const b of data) {
      if (b) {
        this.buf.push(b);
        if (this.buf.length > 4 * MAX_PAYLOAD) { this.buf = []; this.errors++; }
        continue;
      }
      if (!this.buf.length) continue;
      const raw = Uint8Array.from(this.buf);
      this.buf = [];
      try { yield decodeFrame(raw); } catch (e) { this.errors++; }
    }
  }
}

const enc = new TextEncoder();
const dec = new TextDecoder();
const defer = () => { let resolve, reject; const promise = new Promise((a, b) => { resolve = a; reject = b; }); return { promise, resolve, reject }; };

export class Channel {
  constructor(session, id) {
    this.session = session;
    this.id = id;
    this.inflight = 0;
    this.waiters = [];
    this.closed = false;
    this.onData = null;   // async (Uint8Array)
    this.onClose = null;
    this.opened = defer();
    this.rx = Promise.resolve();
  }

  async send(data) {
    for (let i = 0; i < data.length; i += MAX_PAYLOAD) {
      const chunk = data.subarray(i, i + MAX_PAYLOAD);
      while (this.inflight + chunk.length > WINDOW) {
        if (this.closed) return;
        await new Promise((r) => this.waiters.push(r));
      }
      if (this.closed) return;
      this.inflight += chunk.length;
      await this.session.send(T.DATA, this.id, chunk);
    }
  }

  _recv(data) {
    const copy = data.slice();
    this.rx = this.rx.then(async () => {
      if (this.closed) return;
      try { if (this.onData) await this.onData(copy); } catch (e) { return this.close(); }
      await this.session.send(T.ACK, this.id, new Uint8Array(new Uint32Array([copy.length]).buffer));
    });
  }

  _acked(n) {
    this.inflight = Math.max(0, this.inflight - n);
    const w = this.waiters; this.waiters = [];
    w.forEach((r) => r());
  }

  async close(notify = true) {
    if (this.closed) return;
    this.closed = true;
    this.session.channels.delete(this.id);
    this.waiters.splice(0).forEach((r) => r());
    if (notify) { try { await this.session.send(T.CLOSE, this.id); } catch (e) { /* link gone */ } }
    if (this.onClose) this.onClose();
    this.opened.resolve({ ok: false, error: "closed" });
  }
}

export class Session {
  /** link: { write(Uint8Array): Promise, onData: (Uint8Array)=>void, close() } */
  constructor(link) {
    this.link = link;
    this.channels = new Map();
    this.decoder = new Decoder();
    this.nextId = 1;
    this.wq = Promise.resolve();
    this.helloWaiters = [];
    this.helloSeen = false;
    link.onData = (d) => this.feed(d);
  }

  send(type, id, payload) {
    const p = this.wq.then(() => this.link.write(encodeFrame(type, id, payload)));
    this.wq = p.catch(() => {});
    return p;
  }

  async reset() {
    for (const ch of [...this.channels.values()]) await ch.close(false);
  }

  feed(data) {
    for (const f of this.decoder.feed(data)) this._dispatch(f);
  }

  async _dispatch({ type, chan, payload }) {
    if (type === T.HELLO) {
      await this.reset();
      this.helloSeen = true;
      this.helloWaiters.splice(0).forEach((r) => r());
      return;
    }
    const ch = this.channels.get(chan);
    if (!ch) return;
    if (type === T.OPENED) ch.opened.resolve(JSON.parse(dec.decode(payload)));
    else if (type === T.DATA) ch._recv(payload);
    else if (type === T.ACK) ch._acked(new DataView(payload.buffer, payload.byteOffset, 4).getUint32(0, true));
    else if (type === T.CLOSE) { await ch.rx; await ch.close(false); }
  }

  async connect(tries = 5) {
    for (let i = 0; i < tries && !this.helloSeen; i++) {
      await this.send(T.HELLO, 0, enc.encode(JSON.stringify({ v: 1, role: "client" })));
      await Promise.race([new Promise((r) => this.helloWaiters.push(r)), new Promise((r) => setTimeout(r, 1500))]);
    }
    if (!this.helloSeen) throw new Error("no answer from the host daemon");
  }

  async open(params, { onData, onClose } = {}, timeout = 10000) {
    const id = this.nextId;
    this.nextId = (this.nextId % 65535) + 1;
    const ch = new Channel(this, id);
    ch.onData = onData;
    ch.onClose = onClose;
    this.channels.set(id, ch);
    await this.send(T.OPEN, id, enc.encode(JSON.stringify(params)));
    const res = await Promise.race([ch.opened.promise, new Promise((r) => setTimeout(() => r({ ok: false, error: "timed out opening channel" }), timeout))]);
    if (!res.ok) { await ch.close(res.error === "timed out opening channel"); throw new Error(res.error || "open refused"); }
    return ch;
  }

  async info() {
    const parts = [];
    const done = defer();
    await this.open({ kind: "info" }, { onData: async (d) => { parts.push(d); }, onClose: () => done.resolve() });
    await Promise.race([done.promise, new Promise((_, r) => setTimeout(() => r(new Error("info timeout")), 10000))]);
    return JSON.parse(dec.decode(await new Blob(parts).arrayBuffer()));
  }
}

// ---- links ----

export class WebSerialLink {
  constructor(port) { this.port = port; this.onData = () => {}; this.onClose = () => {}; }
  static async request(baudRate) {
    const port = await navigator.serial.requestPort();
    let err;
    for (let i = 0; i < 6; i++) {
      try { await port.open({ baudRate, bufferSize: 8192 }); err = null; break; }
      catch (e) {
        err = e;
        // already open from an earlier failed attempt: its streams are still locked, so reopen cleanly
        if (e.name === "InvalidStateError") { try { await port.close(); } catch (x) { /* locked */ } }
        await new Promise((r) => setTimeout(r, 700));
      }
    }
    if (err) throw new Error(`Failed to open port (${err.name}: ${err.message}). Another program or browser tab is probably holding it; close it and retry.`);
    const link = new WebSerialLink(port);
    link._start();
    return link;
  }
  _start() {
    this.writer = this.port.writable.getWriter();
    this.reader = this.port.readable.getReader();
    (async () => {
      try {
        for (;;) {
          const { value, done } = await this.reader.read();
          if (done) break;
          if (value) this.onData(value);
        }
      } catch (e) { /* port lost */ }
      this.onClose();
    })();
  }
  write(data) { return this.writer.write(data); }
  async close() {
    try { await this.reader.cancel(); } catch (e) { /* ignore */ }
    try { this.reader.releaseLock(); this.writer.releaseLock(); await this.port.close(); } catch (e) { /* ignore */ }
  }
}

/** Development link: a WebSocket carrying the raw serial byte stream (see tools/ws_bridge.py). */
export class WsLink {
  constructor(ws) { this.ws = ws; this.onData = () => {}; this.onClose = () => {}; ws.binaryType = "arraybuffer"; ws.onmessage = (e) => this.onData(new Uint8Array(e.data)); ws.onclose = () => this.onClose(); }
  static open(url) {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(url);
      ws.onopen = () => resolve(new WsLink(ws));
      ws.onerror = () => reject(new Error("cannot reach " + url));
    });
  }
  async write(data) { this.ws.send(data); }
  async close() { this.ws.close(); }
}
