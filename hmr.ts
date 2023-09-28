/// <reference lib="dom">
(() => {
  const loc = document.location;
  const sock = new WebSocket(loc.toString().replace(/^http/, "ws"));
  sock.addEventListener("message", () => loc.reload());
  const open = new Promise((resolve, reject) => {
    sock.addEventListener("open", resolve);
    sock.addEventListener("error", reject);
  });
  window.__hmr = async (extraChannels: string[]) => {
    await open;
    sock.send(JSON.stringify(extraChannels));
  };
})();
