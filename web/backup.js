import { httpRequest } from "./tunnel.js";

const enc = new TextEncoder();
const CRC = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; }
  return t;
})();
const crc32 = (b) => { let c = 0xffffffff; for (let i = 0; i < b.length; i++) c = CRC[(c ^ b[i]) & 255] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };

/** Minimal "stored" (uncompressed) zip writer. files: [{name, data: Uint8Array, time: Date}] */
export function makeZip(files) {
  const parts = [], central = [];
  let off = 0;
  for (const f of files) {
    const name = enc.encode(f.name), crc = crc32(f.data), d = f.time || new Date();
    const dosTime = (d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1);
    const dosDate = ((d.getFullYear() - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate();
    const h = new DataView(new ArrayBuffer(30));
    h.setUint32(0, 0x04034b50, true); h.setUint16(4, 20, true); h.setUint16(6, 0x0800, true);
    h.setUint16(10, dosTime, true); h.setUint16(12, dosDate, true);
    h.setUint32(14, crc, true); h.setUint32(18, f.data.length, true); h.setUint32(22, f.data.length, true);
    h.setUint16(26, name.length, true);
    parts.push(new Uint8Array(h.buffer), name, f.data);
    const c = new DataView(new ArrayBuffer(46));
    c.setUint32(0, 0x02014b50, true); c.setUint16(4, 20, true); c.setUint16(6, 20, true); c.setUint16(8, 0x0800, true);
    c.setUint16(12, dosTime, true); c.setUint16(14, dosDate, true);
    c.setUint32(16, crc, true); c.setUint32(20, f.data.length, true); c.setUint32(24, f.data.length, true);
    c.setUint16(28, name.length, true); c.setUint32(42, off, true);
    central.push(new Uint8Array(c.buffer), name);
    off += 30 + name.length + f.data.length;
  }
  const csize = central.reduce((n, p) => n + p.length, 0);
  const e = new DataView(new ArrayBuffer(22));
  e.setUint32(0, 0x06054b50, true); e.setUint16(8, files.length, true); e.setUint16(10, files.length, true);
  e.setUint32(12, csize, true); e.setUint32(16, off, true);
  return new Blob([...parts, ...central, new Uint8Array(e.buffer)], { type: "application/zip" });
}

async function get(session, path, port) {
  const r = await httpRequest(session, { method: "GET", path, headers: {}, body: null, port });
  if (r.status !== 200) throw new Error(`${path}: HTTP ${r.status}`);
  return new Uint8Array(await new Response(r.body).arrayBuffer());
}

/** Downloads every file in Moonraker's `config` root (printer.cfg, moonraker.conf, macros, ...) as a zip. */
export async function backupConfig(session, port, onProgress = () => {}) {
  const list = JSON.parse(new TextDecoder().decode(await get(session, "/server/files/list?root=config", port)));
  const entries = list.result || [];
  const files = [];
  for (const [i, e] of entries.entries()) {
    onProgress(`${i + 1}/${entries.length} ${e.path}`);
    const data = await get(session, "/server/files/config/" + e.path.split("/").map(encodeURIComponent).join("/"), port);
    files.push({ name: "config/" + e.path, data, time: new Date((e.modified || Date.now() / 1000) * 1000) });
  }
  return { blob: makeZip(files), count: files.length };
}
