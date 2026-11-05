// HTTP/1.1 and WebSocket clients running over a serial-klipper TCP channel.
const enc = new TextEncoder();
const dec = new TextDecoder();

function concat(a, b) {
  if (!a.length) return b;
  const o = new Uint8Array(a.length + b.length);
  o.set(a); o.set(b, a.length);
  return o;
}

function indexOfSeq(buf, seq, from = 0) {
  outer: for (let i = from; i <= buf.length - seq.length; i++) {
    for (let j = 0; j < seq.length; j++) if (buf[i + j] !== seq[j]) continue outer;
    return i;
  }
  return -1;
}
const CRLFCRLF = [13, 10, 13, 10];
const CRLF = [13, 10];

const DROP_REQ_HEADERS = new Set(["host", "connection", "origin", "referer", "cookie", "content-length", "accept-encoding",
  "upgrade", "te", "keep-alive", "transfer-encoding", "expect", "priority"]);

/**
 * Perform one HTTP request through the tunnel.
 * Resolves with { status, statusText, headers: [[k,v]...], body: ReadableStream|null } once headers arrive.
 */
export async function httpRequest(session, { method, path, headers = [], body = null, port = 7125, signal }) {
  let head = `${method} ${path} HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\nConnection: close\r\nAccept-Encoding: identity\r\n`;
  for (const [k, v] of headers) if (!DROP_REQ_HEADERS.has(k.toLowerCase()) && !k.toLowerCase().startsWith("sec-")) head += `${k}: ${v}\r\n`;
  if (body && body.length) head += `Content-Length: ${body.length}\r\n`;
  else if (!["GET", "HEAD", "DELETE", "OPTIONS"].includes(method)) head += "Content-Length: 0\r\n";
  head += "\r\n";

  let buf = new Uint8Array(0);
  let state = "head";          // head | length | chunked | until-close | done
  let remaining = 0;
  let chunk = { phase: "size", left: 0 };
  let controller = null;
  let resolveHead, rejectHead;
  const headP = new Promise((res, rej) => { resolveHead = res; rejectHead = rej; });
  let noBody = method === "HEAD";
  let bodyStream = null;
  let ch = null;

  const finish = () => {
    if (state !== "done") { state = "done"; try { controller && controller.close(); } catch (e) { /* closed */ } }
  };
  const push = (u8) => { if (u8.length && controller) controller.enqueue(u8); };

  const parseHead = () => {
    const end = indexOfSeq(buf, CRLFCRLF);
    if (end < 0) return false;
    const lines = dec.decode(buf.subarray(0, end)).split("\r\n");
    buf = buf.subarray(end + 4);
    const m = /^HTTP\/1\.[01] (\d{3}) ?(.*)$/.exec(lines[0]);
    if (!m) throw new Error("bad HTTP response from tunnel");
    const status = +m[1];
    const hdrs = lines.slice(1).map((l) => { const i = l.indexOf(":"); return [l.slice(0, i).trim(), l.slice(i + 1).trim()]; });
    const get = (n) => (hdrs.find(([k]) => k.toLowerCase() === n) || [])[1];
    if (status < 200 || status === 204 || status === 304) noBody = true;
    const te = (get("transfer-encoding") || "").toLowerCase();
    const cl = get("content-length");
    if (noBody) state = "done";
    else if (te.includes("chunked")) state = "chunked";
    else if (cl !== undefined) { state = "length"; remaining = +cl; if (!remaining) state = "done"; }
    else state = "until-close";
    const outHeaders = hdrs.filter(([k]) => !["transfer-encoding", "connection", "keep-alive"].includes(k.toLowerCase()));
    if (state !== "done") {
      bodyStream = new ReadableStream({
        start(c) { controller = c; },
        cancel() { if (ch) ch.close(); },
      });
    }
    resolveHead({ status, statusText: m[2], headers: outHeaders, body: bodyStream });
    if (state === "done") ch && ch.close();
    return true;
  };

  const pump = () => {
    for (;;) {
      if (state === "head") { if (!parseHead()) return; continue; }
      if (state === "length") {
        const n = Math.min(remaining, buf.length);
        push(buf.subarray(0, n)); buf = buf.subarray(n); remaining -= n;
        if (remaining === 0) { finish(); ch && ch.close(); }
        return;
      }
      if (state === "until-close") { push(buf); buf = new Uint8Array(0); return; }
      if (state === "chunked") {
        if (chunk.phase === "size") {
          const i = indexOfSeq(buf, CRLF);
          if (i < 0) return;
          chunk.left = parseInt(dec.decode(buf.subarray(0, i)).split(";")[0], 16);
          buf = buf.subarray(i + 2);
          if (chunk.left === 0) { chunk.phase = "trailer"; } else chunk.phase = "data";
          continue;
        }
        if (chunk.phase === "data") {
          const n = Math.min(chunk.left, buf.length);
          push(buf.subarray(0, n)); buf = buf.subarray(n); chunk.left -= n;
          if (chunk.left > 0) return;
          chunk.phase = "crlf";
          continue;
        }
        if (chunk.phase === "crlf") {
          if (buf.length < 2) return;
          buf = buf.subarray(2); chunk.phase = "size";
          continue;
        }
        if (chunk.phase === "trailer") {
          const i = indexOfSeq(buf, CRLF);
          if (i < 0) return;
          buf = buf.subarray(i + 2);
          if (i === 0) { finish(); ch && ch.close(); return; }
          continue;
        }
      }
      return;
    }
  };

  ch = await session.open({ kind: "tcp", host: "127.0.0.1", port }, {
    onData: async (d) => { buf = concat(buf, d); try { pump(); } catch (e) { rejectHead(e); finish(); } },
    onClose: () => {
      if (state === "head") rejectHead(new Error("tunnel closed before response"));
      else if (state === "until-close" || state === "length" || state === "chunked") {
        try { controller && controller.error(new Error("tunnel closed")); } catch (e) { /* ignore */ }
        if (state === "until-close") { /* normal end */ }
      }
    },
  });
  if (signal) signal.addEventListener("abort", () => ch.close());
  await ch.send(enc.encode(head));
  if (body && body.length) await ch.send(body);
  return headP;
}

// ---- WebSocket ----

const CONNECTING = 0, OPEN = 1, CLOSING = 2, CLOSED = 3;

async function wsAccept(key) {
  const d = await crypto.subtle.digest("SHA-1", enc.encode(key + "258EAFA5-E914-47DA-95CA-C5AB0DC85B11"));
  return btoa(String.fromCharCode(...new Uint8Array(d)));
}

/** Build a WebSocket-compatible class that tunnels to localhost:port on the Klipper host. */
export function makeWebSocketClass(getSession, port = 7125) {
  class SkWebSocket extends EventTarget {
    constructor(url, protocols) {
      super();
      this.url = String(url);
      this.readyState = CONNECTING;
      this.binaryType = "blob";
      this.bufferedAmount = 0;
      this.extensions = "";
      this.protocol = "";
      this.onopen = this.onmessage = this.onclose = this.onerror = null;
      this._buf = new Uint8Array(0);
      this._frag = null;
      this._hs = true;
      const u = new URL(this.url, location.href);
      const i = u.pathname.indexOf("/api/");
      this._path = (i >= 0 ? u.pathname.slice(i + 4) : u.pathname) + u.search;
      this._protocols = protocols === undefined ? [] : [].concat(protocols);
      this._start();
    }

    _emit(type, init) {
      const ev = type === "message" ? new MessageEvent("message", init) : type === "close" ? new CloseEvent("close", init) : new Event(type);
      const h = this["on" + type];
      if (h) { try { h.call(this, ev); } catch (e) { console.error(e); } }
      this.dispatchEvent(ev);
    }

    async _start() {
      try {
        const s = getSession();
        if (!s) throw new Error("serial link not connected");
        this._key = btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(16))));
        this._ch = await s.open({ kind: "tcp", host: "127.0.0.1", port }, {
          onData: (d) => this._onBytes(d),
          onClose: () => this._closed(1006, ""),
        });
        let req = `GET ${this._path} HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: ${this._key}\r\nSec-WebSocket-Version: 13\r\n`;
        if (this._protocols.length) req += `Sec-WebSocket-Protocol: ${this._protocols.join(", ")}\r\n`;
        await this._ch.send(enc.encode(req + "\r\n"));
      } catch (e) {
        this._emit("error");
        this._closed(1006, String(e && e.message));
      }
    }

    async _onBytes(d) {
      this._buf = concat(this._buf, d);
      if (this._hs) {
        const end = indexOfSeq(this._buf, CRLFCRLF);
        if (end < 0) return;
        const head = dec.decode(this._buf.subarray(0, end)).split("\r\n");
        this._buf = this._buf.subarray(end + 4);
        const accept = head.map((l) => /^sec-websocket-accept:\s*(.+)$/i.exec(l)).find(Boolean);
        if (!/ 101 /.test(head[0] + " ") || !accept || accept[1].trim() !== await wsAccept(this._key)) {
          this._emit("error");
          this._ch.close();
          return;
        }
        const proto = head.map((l) => /^sec-websocket-protocol:\s*(.+)$/i.exec(l)).find(Boolean);
        if (proto) this.protocol = proto[1].trim();
        this._hs = false;
        this.readyState = OPEN;
        this._emit("open");
      }
      for (;;) {
        const b = this._buf;
        if (b.length < 2) return;
        const fin = b[0] & 0x80, op = b[0] & 0x0f;
        let len = b[1] & 0x7f, off = 2;
        if (len === 126) { if (b.length < 4) return; len = (b[2] << 8) | b[3]; off = 4; }
        else if (len === 127) { if (b.length < 10) return; len = Number(new DataView(b.buffer, b.byteOffset + 2, 8).getBigUint64(0)); off = 10; }
        if (b.length < off + len) return;
        const payload = b.slice(off, off + len);
        this._buf = b.subarray(off + len);
        if (op === 0x9) this._frame(0xA, payload);
        else if (op === 0x8) {
          const code = payload.length >= 2 ? (payload[0] << 8) | payload[1] : 1005;
          if (this.readyState === OPEN) this._frame(0x8, payload.subarray(0, 2));
          this._closed(code, dec.decode(payload.subarray(2)));
          this._ch.close();
          return;
        } else if (op === 0xA) { /* pong */ }
        else {
          if (op !== 0) this._frag = { op, parts: [] };
          if (!this._frag) continue;
          this._frag.parts.push(payload);
          if (fin) {
            const all = this._frag.parts.reduce(concat, new Uint8Array(0));
            const textual = this._frag.op === 0x1;
            this._frag = null;
            let data;
            if (textual) data = dec.decode(all);
            else data = this.binaryType === "arraybuffer" ? all.buffer.slice(all.byteOffset, all.byteOffset + all.byteLength) : new Blob([all]);
            this._emit("message", { data });
          }
        }
      }
    }

    _frame(op, payload) {
      const mask = crypto.getRandomValues(new Uint8Array(4));
      const n = payload.length;
      const hdr = n < 126 ? [0x80 | op, 0x80 | n] : n < 65536 ? [0x80 | op, 0x80 | 126, n >> 8, n & 255]
        : [0x80 | op, 0x80 | 127, 0, 0, 0, 0, (n >>> 24) & 255, (n >> 16) & 255, (n >> 8) & 255, n & 255];
      const out = new Uint8Array(hdr.length + 4 + n);
      out.set(hdr); out.set(mask, hdr.length);
      for (let i = 0; i < n; i++) out[hdr.length + 4 + i] = payload[i] ^ mask[i & 3];
      return this._ch.send(out);
    }

    send(data) {
      if (this.readyState !== OPEN) throw new DOMException("WebSocket is not open", "InvalidStateError");
      if (typeof data === "string") return void this._frame(0x1, enc.encode(data));
      if (data instanceof Blob) return void data.arrayBuffer().then((b) => this._frame(0x2, new Uint8Array(b)));
      this._frame(0x2, data instanceof ArrayBuffer ? new Uint8Array(data) : new Uint8Array(data.buffer, data.byteOffset, data.byteLength));
    }

    close(code = 1000, reason = "") {
      if (this.readyState >= CLOSING) return;
      if (this.readyState === CONNECTING) { this.readyState = CLOSING; if (this._ch) this._ch.close(); return this._closed(1006, ""); }
      this.readyState = CLOSING;
      this._frame(0x8, Uint8Array.from([code >> 8, code & 255, ...enc.encode(reason)]));
    }

    _closed(code, reason) {
      if (this.readyState === CLOSED) return;
      this.readyState = CLOSED;
      this._emit("close", { code, reason, wasClean: code !== 1006 });
    }
  }
  Object.assign(SkWebSocket, { CONNECTING, OPEN, CLOSING, CLOSED });
  Object.assign(SkWebSocket.prototype, { CONNECTING, OPEN, CLOSING, CLOSED });
  return SkWebSocket;
}
