import dns from "dns";

// Force public DNS to bypass OS negative cache (mDNSResponder holds NXDOMAIN)
// 223.5.5.5 (Alibaba) is reachable in CN where 1.1.1.1 is blocked.
const resolver = new dns.promises.Resolver();
resolver.setServers(["223.5.5.5", "8.8.8.8", "1.1.1.1"]);

// Try custom public DNS first, fall back to OS resolver
// (Cloudflare DNS may not resolve all hostnames, e.g. *.ts.net)
export async function resolveDns(hostname, timeoutMs) {
  const tryResolver = (fn) => Promise.race([
    fn(),
    new Promise((_, rej) => setTimeout(() => rej(new Error("dns timeout")), timeoutMs)),
  ]).then(() => true).catch(() => false);

  if (await tryResolver(() => resolver.resolve4(hostname))) return true;
  return tryResolver(() => dns.promises.resolve4(hostname));
}
