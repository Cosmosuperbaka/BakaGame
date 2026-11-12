import { describe, expect, it } from "bun:test";
import { parseChinaIpRanges } from "../src/infrastructure/ChinaIpRanges";
import { MusicIpScopeRegistry } from "../src/infrastructure/MusicIpScope";

const createRegistry = () => {
  let seed = 0;
  return new MusicIpScopeRegistry({
    now: () => 0,
    // 确定性但每次不同的随机源，保证不同 scope 拿到不同 IP。
    random: { nextFloat: () => ((seed += 1) * 0.6180339887) % 1 },
    chinaIpRanges: parseChinaIpRanges("1.0.0.0/8"),
    platformKey: "netease",
  });
};

describe("伪装出口 IP 登记表", () => {
  it("持续被使用的房主地址不会被大量新连接挤掉而漂移", () => {
    const registry = createRegistry();
    const hostScope = registry.cookieScope("MUSIC_U=host");
    const hostIp = registry.ensureScopeIp(hostScope);

    // 远超登记表容量的新连接涌入，房主期间持续有请求。
    for (let index = 0; index < 6_000; index += 1) {
      registry.ensureScopeIp(`player:conn-${index}`);
      if (index % 10 === 0) expect(registry.ensureScopeIp(hostScope)).toBe(hostIp);
    }
    expect(registry.ensureScopeIp(hostScope)).toBe(hostIp);
  });

  it("登录会话 IP 固化到房主凭证后同样随使用保鲜", () => {
    const registry = createRegistry();
    const sessionIp = registry.ensureScopeIp("qr-login:abc");
    registry.bindSessionIp("MUSIC_U=host", "qr-login:abc");
    const hostScope = registry.cookieScope("MUSIC_U=host");

    for (let index = 0; index < 6_000; index += 1) {
      registry.ensureScopeIp(`player:conn-${index}`);
      if (index % 10 === 0) registry.ensureScopeIp(hostScope);
    }
    expect(registry.ensureScopeIp(hostScope)).toBe(sessionIp);
  });
});
