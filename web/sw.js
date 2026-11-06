// Routes <scope>/api/* to the launcher page (which owns the serial link) and tailors the apps' config.json.
const scope = new URL(self.registration.scope);
const API = scope.pathname + "api/";

self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (e) => e.waitUntil(self.clients.claim()));

async function launcher() {
  const all = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
  return all.find((c) => c.frameType === "top-level");
}

async function tunnel(request, url) {
  const client = await launcher();
  if (!client) return new Response("serial-klipper launcher page is not open", { status: 503 });
  const body = ["GET", "HEAD"].includes(request.method) ? null : await request.arrayBuffer();
  const ch = new MessageChannel();
  const path = "/" + url.pathname.slice(API.length) + url.search;
  const headers = [...request.headers.entries()];
  return new Promise((resolve) => {
    let controller;
    let settled = false;
    ch.port1.onmessage = ({ data }) => {
      if (data.type === "head") {
        const nobody = data.status === 204 || data.status === 304 || request.method === "HEAD" || data.noBody;
        const stream = nobody ? null : new ReadableStream({
          start(c) { controller = c; },
          cancel() { ch.port1.postMessage({ type: "cancel" }); },
        });
        settled = true;
        resolve(new Response(stream, { status: data.status, statusText: data.statusText, headers: data.headers }));
      } else if (data.type === "chunk") controller && controller.enqueue(new Uint8Array(data.data));
      else if (data.type === "end") { try { controller && controller.close(); } catch (e) { /* closed */ } }
      else if (data.type === "error") {
        if (!settled) resolve(new Response(data.message, { status: 502 }));
        else { try { controller.error(new Error(data.message)); } catch (e) { /* closed */ } }
      }
    };
    client.postMessage({ type: "http", method: request.method, path, headers, body, port: ch.port2 }, [ch.port2, ...(body ? [body] : [])]);
  });
}

async function appConfig(request, app) {
  const real = await fetch(scope.pathname + app + "/config.json");
  const cfg = real.ok ? await real.json() : {};
  const u = new URL(scope);
  const apiUrl = u.origin + API.replace(/\/$/, "");
  if (app === "fluidd") cfg.endpoints = [apiUrl];
  else Object.assign(cfg, { hostname: u.hostname, port: Number(u.port) || (u.protocol === "https:" ? 443 : 80), path: API.replace(/\/$/, "") });
  return new Response(JSON.stringify(cfg), { headers: { "content-type": "application/json" } });
}

self.addEventListener("fetch", (event) => {
  const url = new URL(event.request.url);
  if (url.origin !== location.origin) return;
  if (url.pathname.startsWith(API)) return event.respondWith(tunnel(event.request, url));
  const m = /\/(fluidd|mainsail)\/config\.json$/.exec(url.pathname);
  if (m && url.pathname.startsWith(scope.pathname)) return event.respondWith(appConfig(event.request, m[1]));
  // Mainsail requests the root-absolute /config.json
  if (url.pathname === "/config.json") return event.respondWith(appConfig(event.request, "mainsail"));
});
