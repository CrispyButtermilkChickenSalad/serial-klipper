import { Session, WebSerialLink, WsLink } from "./sk.js";
import { httpRequest, makeWebSocketClass } from "./tunnel.js";
import { backupConfig } from "./backup.js";

const $ = (id) => document.getElementById(id);
let session = null;
let link = null;
let hostPort = 7125;

window.__sk = { WebSocket: makeWebSocketClass(() => session, hostPort) };

const setStatus = (t, cls = "muted") => { $("status").textContent = t; $("status").className = cls; };
const showError = (e) => { $("error").textContent = e ? String(e.message || e) : ""; };

if (!("serial" in navigator)) $("unsupported").hidden = false;

// ---- Service worker: tunnels the apps' HTTP requests ----
const swReady = "serviceWorker" in navigator
  ? navigator.serviceWorker.register("sw.js", { updateViaCache: "none" }).then(() => navigator.serviceWorker.ready)
  : Promise.reject(new Error("service workers unavailable"));

navigator.serviceWorker && navigator.serviceWorker.addEventListener("message", async ({ data }) => {
  if (data.type !== "http") return;
  const port = data.port;
  try {
    if (!session) throw new Error("serial link not connected");
    const ctl = new AbortController();
    port.onmessage = ({ data: m }) => { if (m.type === "cancel") ctl.abort(); };
    const r = await httpRequest(session, {
      method: data.method, path: data.path, headers: data.headers,
      body: data.body ? new Uint8Array(data.body) : null, port: hostPort, signal: ctl.signal,
    });
    port.postMessage({ type: "head", status: r.status, statusText: r.statusText, headers: r.headers, noBody: !r.body });
    if (r.body) {
      const rd = r.body.getReader();
      for (;;) {
        const { value, done } = await rd.read();
        if (done) break;
        port.postMessage({ type: "chunk", data: value.buffer.slice(value.byteOffset, value.byteOffset + value.byteLength) });
      }
    }
    port.postMessage({ type: "end" });
  } catch (e) {
    port.postMessage({ type: "error", message: String(e.message || e) });
  }
});

// ---- connection ----
async function attach(newLink) {
  link = newLink;
  session = new Session(link);
  link.onClose = () => { setStatus("link lost", "err"); showMenu(); $("connect").hidden = false; $("ready").hidden = true; $("disconnect").hidden = true; session = null; };
  setStatus("handshaking…");
  let info;
  try {
    await session.connect();
    info = await session.info();
  } catch (e) {
    link.onClose = () => {};
    await link.close();
    session = null;
    throw e;
  }
  setStatus("connected", "ok");
  $("connect").hidden = true;
  $("ready").hidden = false;
  $("disconnect").hidden = false;
  $("hostname").textContent = `${info.hostname} (serial-klipper ${info.version})`;
  fillSpeeds(info);
  const tb = $("devices").tBodies[0];
  tb.innerHTML = "";
  for (const d of info.devices) {
    const tr = tb.insertRow();
    const state = d.link ? "link" : d.in_use.length ? "in use: " + d.in_use.join(", ") : "free";
    [d.name, d.real, state].forEach((t) => { tr.insertCell().textContent = t; });
    const b = document.createElement("button");
    b.textContent = "Console";
    b.disabled = d.link;
    b.onclick = () => openConsole(d, d.in_use.length > 0);
    tr.insertCell().append(b);
  }
}

function fillSpeeds(info) {
  const sel = $("speed");
  sel.innerHTML = "";
  const cur = info.link_baud || +$("baud").value;
  for (const b of info.bauds || []) sel.add(new Option(b, b, false, b === cur));
  $("speedBtn").disabled = !(info.bauds && link && link.reopen);
  $("speedMsg").textContent = `current: ${cur}`;
}

$("speedBtn").onclick = async () => {
  const baud = +$("speed").value;
  $("speedBtn").disabled = true;
  try {
    const ch = await session.open({ kind: "baud", baud });
    await ch.close(false);
    $("speedMsg").textContent = "switching…";
    await new Promise((r) => setTimeout(r, 1500));
    await link.reopen(baud);
    session = new Session(link);
    await session.connect();
    fillSpeeds(await session.info());
    setStatus("connected", "ok");
  } catch (e) {
    $("speedMsg").textContent = "failed: " + (e.message || e) + " (host reverts to its default speed in ~15 s; reconnect)";
    setStatus("link lost", "err");
  }
  $("speedBtn").disabled = false;
};

$("backupBtn").onclick = async () => {
  $("backupBtn").disabled = true;
  try {
    const { blob, count } = await backupConfig(session, hostPort, (t) => { $("backupMsg").textContent = t; });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = "klipper-config.zip";
    a.click();
    $("backupMsg").textContent = `saved ${count} files`;
  } catch (e) { $("backupMsg").textContent = "failed: " + (e.message || e); }
  $("backupBtn").disabled = false;
};

$("connectBtn").onclick = async () => {
  showError("");
  try {
    await swReady;
    await attach(await WebSerialLink.request(+$("baud").value || 115200));
  } catch (e) { showError(e); setStatus("not connected"); }
};

$("disconnect").onclick = async () => {
  $("app").hidden = true; $("app").src = "about:blank";
  const l = link; link = null; session = null;
  if (l) { l.onClose = () => {}; await l.close(); }
  $("connect").hidden = false; $("ready").hidden = true; $("menu").hidden = false;
  $("disconnect").hidden = true; $("back").hidden = true;
  setStatus("not connected");
};

function showMenu() { $("app").hidden = true; $("menu").hidden = false; $("back").hidden = true; }
$("back").onclick = showMenu;

async function openApp(name) {
  await swReady;
  $("menu").hidden = true; $("back").hidden = false;
  const f = $("app");
  f.hidden = false;
  if (!f.src.includes(`/${name}/`)) f.src = `${name}/`;
}
$("openFluidd").onclick = () => openApp("fluidd");
$("openMainsail").onclick = () => openApp("mainsail");

// ---- serial console on a host device ----
let consoleCh = null;
async function openConsole(dev, force) {
  if (force && !confirm(`${dev.name} is held by ${dev.in_use.join(", ")}. Opening it can disrupt Klipper. Continue?`)) return;
  const baud = +prompt("Baud rate for " + dev.name, "115200");
  if (!baud) return;
  if (consoleCh) await consoleCh.close();
  const term = $("term");
  term.textContent = "";
  const dec = new TextDecoder();
  try {
    consoleCh = await session.open({ kind: "serial", device: dev.name, baud, force }, {
      onData: async (d) => { term.textContent += dec.decode(d, { stream: true }); term.scrollTop = term.scrollHeight; },
      onClose: () => { term.textContent += "\n[closed]\n"; },
    });
    $("consoleTitle").textContent = `${dev.name} @ ${baud}`;
    $("consoleBox").hidden = false;
  } catch (e) { showError(e); }
}
$("termInput").onkeydown = (e) => {
  if (e.key !== "Enter" || !consoleCh) return;
  consoleCh.send(new TextEncoder().encode($("termInput").value + ($("termCrlf").checked ? "\r\n" : "\n")));
  $("termInput").value = "";
};
$("termClose").onclick = async () => { if (consoleCh) await consoleCh.close(); consoleCh = null; $("consoleBox").hidden = true; };

// Development: ?link=ws://host:port connects through tools/ws_bridge.py instead of Web Serial.
const dev = new URLSearchParams(location.search).get("link");
if (dev) swReady.then(() => WsLink.open(dev)).then(attach).catch(showError);
