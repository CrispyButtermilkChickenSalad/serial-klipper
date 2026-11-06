// Injected into Fluidd/Mainsail when they run inside the serial-klipper launcher iframe.
(function () {
  var host = window.parent;
  if (!host || host === window || !host.__sk) return;
  window.WebSocket = host.__sk.WebSocket;
  if (navigator.serviceWorker) {
    navigator.serviceWorker.register = function () { return Promise.reject(new Error("service workers are managed by serial-klipper")); };
  }
  if (/\/fluidd\//.test(location.pathname)) {
    var base = new URL(".", document.currentScript.src).pathname.replace(/\/$/, "");
    var api = location.origin + base + "/api";
    var ws = (location.protocol === "https:" ? "wss://" : "ws://") + location.host + base + "/api/websocket";
    try {
      localStorage.setItem("appInstances", JSON.stringify([{ name: "Klipper", apiUrl: api, socketUrl: ws, active: true }]));
    } catch (e) { /* storage unavailable */ }
  }
})();
