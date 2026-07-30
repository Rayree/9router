import net from "net";

const INTERNET_CHECK = {
  // 1.1.1.1 is blocked in some regions (e.g. CN). 223.5.5.5 (Alibaba DNS) is
  // reliably reachable there and also works globally, so use it as primary.
  host: "223.5.5.5",
  port: 443,
  timeoutMs: 3000,
};

export function checkInternet() {
  return new Promise((resolve) => {
    const socket = new net.Socket();
    let done = false;
    const finish = (ok) => {
      if (done) return;
      done = true;
      try { socket.destroy(); } catch { /* ignore */ }
      resolve(ok);
    };
    socket.setTimeout(INTERNET_CHECK.timeoutMs);
    socket.once("connect", () => finish(true));
    socket.once("timeout", () => finish(false));
    socket.once("error", () => finish(false));
    try { socket.connect(INTERNET_CHECK.port, INTERNET_CHECK.host); }
    catch { finish(false); }
  });
}
