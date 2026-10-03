import net from "node:net";
import http from "node:http";
import https from "node:https";
import dns from "node:dns";
import tls from "node:tls";
import dgram from "node:dgram";

const checks = [
  () => fetch("https://fixture.invalid"),
  () => fetch.preconnect("https://fixture.invalid"),
  () => new WebSocket("wss://fixture.invalid"),
  () => net.connect(443, "fixture.invalid"),
  () => http.get("http://fixture.invalid"),
  () => https.request("https://fixture.invalid"),
  () => dns.lookup("fixture.invalid", () => {}),
  () => dns.resolve("fixture.invalid", () => {}),
  () => dns.promises.lookup("fixture.invalid"),
  () => dns.resolve4("fixture.invalid", () => {}),
  () => new dns.Resolver().resolve4("fixture.invalid", () => {}),
  () => dns.promises.resolve4("fixture.invalid"),
  () => new dns.promises.Resolver().resolve4("fixture.invalid"),
  () => tls.connect(443, "fixture.invalid"),
  () => Bun.connect({ hostname: "fixture.invalid", port: 443, socket: {} }),
];
for (const check of checks) {
  try { await check(); throw new Error("出口未封闭"); }
  catch (error) {
    if (!(error instanceof Error) || error.message !== "隔离测试禁止主动网络出口") throw error;
  }
}
const udp = dgram.createSocket("udp4");
try { udp.send("fixture", 443, "fixture.invalid"); throw new Error("UDP 出口未封闭"); }
catch (error) {
  if (!(error instanceof Error) || error.message !== "隔离测试禁止主动网络出口") throw error;
}
console.log(JSON.stringify({ checks: checks.length + 1, marker: Bun.env.FIXTURE_ENV_MARKER ?? null, sentry: Bun.env.SENTRY_DSN ?? null }));
