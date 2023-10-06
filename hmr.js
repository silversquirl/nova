// Using JS because it's too annoying to properly set up TS for a single tiny frontend file
(() => {
  const loc = document.location;
  const sock = new WebSocket(loc.toString().replace(/^http/, "ws"));
  sock.addEventListener("message", (event) => {
    loc.reload();
  });
  const open = new Promise((resolve, reject) => {
    sock.addEventListener("open", resolve);
    sock.addEventListener("error", reject);
  });
  window.__hmr = async (extraChannels) => {
    await open;
    // console.log("[hmr] subscribe ", extraChannels);
    sock.send(JSON.stringify(extraChannels));
  };
  open.then(() => console.log("[hmr] connected"));
  sock.addEventListener("close", () => console.log("[hmr] disconnected"));
})();
