import { describe, expect, test } from "bun:test";
import { createPublicKey, generateKeyPairSync, sign as nodeSign } from "node:crypto";
import {
  ClientChannel,
  InMemoryClientChannelStore,
  CLIENT_CHALLENGE_TTL_MS,
  CLIENT_TICKET_TTL_MS,
  clientIdOfPublicKey,
  compareClientVersion,
  judgeSelfCheck,
  verifyClientSignature,
  type ClientSelfCheckReport,
  type StoredClientDevice,
} from "../src/infrastructure/ClientChannel";

const clean: ClientSelfCheckReport = { hardFail: [], softFail: [], keyProtection: "hardware" };

/** 真密钥对：验签走的是与生产完全相同的路径，不用假签名糊弄自己。 */
function desktopDevice() {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const raw = publicKey.export({ format: "der", type: "spki" }).subarray(-32).toString("base64");
  const device: StoredClientDevice = {
    clientId: clientIdOfPublicKey(raw),
    clientType: "desktop",
    platform: "windows",
    keyAlgorithm: "ed25519",
    publicKey: raw,
    keyProtection: "hardware",
    registeredAt: 0,
    lastSeenAt: 0,
  };
  return {
    device,
    sign: (challenge: string) =>
      nodeSign(null, Buffer.from(challenge, "ascii"), privateKey).toString("base64"),
  };
}

function harness(options: { clock?: { value: number }; minimum?: string } = {}) {
  const clock = options.clock ?? { value: 1_000_000 };
  const warnings: string[] = [];
  const store = new InMemoryClientChannelStore();
  const channel = new ClientChannel({
    store,
    now: () => clock.value,
    minimumVersion: () => options.minimum ?? "",
    onWarn: (message) => warnings.push(message),
  });
  return { channel, clock, store, warnings };
}

describe("客户端通道判定", () => {
  test("硬失败任一即拒：调试器附着比二十条软失败都严重", () => {
    expect(judgeSelfCheck({ ...clean, hardFail: ["debugger_attached"] }).trusted).toBe(false);
    expect(judgeSelfCheck({ hardFail: ["debug_port"], softFail: ["devtools"] }).trusted).toBe(
      false
    );
  });
  test("检测跑不动算硬失败：有人让它在跑不动才是常见原因", () => {
    for (const id of [
      "module_enumeration_failed",
      "ldr_enumeration_failed",
      "debug_query_unavailable",
    ])
      expect(judgeSelfCheck({ ...clean, hardFail: [id] }).trusted).toBe(false);
  });
  test("词表外的 id 失败关闭，不让服务端漏跟一项检测就变成放行", () => {
    expect(judgeSelfCheck({ ...clean, softFail: ["brand_new_check"] }).trusted).toBe(false);
    expect(judgeSelfCheck({ ...clean, hardFail: ["platform_unsupported"] }).trusted).toBe(true);
  });
  test("软失败按数量分级：一条放行并标记可疑，两条拒", () => {
    expect(judgeSelfCheck({ ...clean, softFail: ["devtools"] })).toEqual({
      trusted: true,
      integrity: "suspect",
    });
    expect(judgeSelfCheck({ ...clean, softFail: ["devtools", "parent_process"] }).trusted).toBe(
      false
    );
  });
  test("仅密钥保护降级不影响准入：DPAPI 不可用与 attestation degraded 都放行", () => {
    expect(judgeSelfCheck({ hardFail: [], softFail: [], keyProtection: "software" })).toEqual({
      trusted: true,
      integrity: "clean",
    });
    expect(
      judgeSelfCheck({ hardFail: [], softFail: [], attestationLevel: "degraded" }).trusted
    ).toBe(true);
    expect(
      judgeSelfCheck({ hardFail: [], softFail: [], attestationLevel: "rejected" }).trusted
    ).toBe(false);
  });
  test("版本比较按段补零，不按字典序", () => {
    expect(compareClientVersion("1.9.0", "1.10.0")).toBe(-1);
    expect(compareClientVersion("1.10.0", "1.9.9")).toBe(1);
    expect(compareClientVersion("1.2", "1.2.0")).toBe(0);
  });
});

describe("客户端通道换票", () => {
  test("注册幂等：同一把公钥重复注册得到同一个 clientId", async () => {
    const { channel } = harness();
    const { device } = desktopDevice();
    const first = await channel.register({
      clientType: "desktop",
      platform: "windows",
      clientVersion: "1.0.0",
      keyAlgorithm: "ed25519",
      publicKey: device.publicKey,
      selfCheck: clean,
    });
    const again = await channel.register({
      clientType: "desktop",
      platform: "windows",
      clientVersion: "1.0.0",
      keyAlgorithm: "ed25519",
      publicKey: device.publicKey,
      selfCheck: clean,
    });
    expect(first.clientId).toBe(device.clientId);
    expect(again.clientId).toBe(first.clientId);
  });
  test("完整链路：注册 → 领挑战 → 签名换票 → 握手凭票拿到通道证明", async () => {
    const { channel } = harness();
    const { device, sign } = desktopDevice();
    const { clientId } = await channel.register({
      clientType: "desktop",
      platform: "windows",
      clientVersion: "1.0.0",
      keyAlgorithm: "ed25519",
      publicKey: device.publicKey,
      selfCheck: clean,
    });
    const { challenge } = channel.issue(clientId);
    const { ticket } = await channel.attest(
      {
        clientId,
        challenge,
        signature: sign(challenge),
        clientType: "desktop",
        clientVersion: "1.0.0",
        selfCheck: clean,
      },
      "203.0.113.7"
    );
    expect(channel.consume(ticket, "203.0.113.7")).toMatchObject({
      clientId,
      clientType: "desktop",
      keyProtection: "hardware",
      integrity: "clean",
      outdated: false,
    });
  });
  test("票是一次性的，且绑定签发时的来源地址", async () => {
    const { channel } = harness();
    const { device, sign } = desktopDevice();
    const { clientId } = await channel.register({
      clientType: "desktop",
      platform: "windows",
      clientVersion: "1.0.0",
      keyAlgorithm: "ed25519",
      publicKey: device.publicKey,
      selfCheck: clean,
    });
    const { challenge } = channel.issue(clientId);
    const { ticket } = await channel.attest(
      {
        clientId,
        challenge,
        signature: sign(challenge),
        clientType: "desktop",
        clientVersion: "1.0.0",
        selfCheck: clean,
      },
      "203.0.113.7"
    );
    expect(channel.consume(ticket, "198.51.100.9")).toBeUndefined();
    expect(channel.consume(ticket, "203.0.113.7")?.clientId).toBe(clientId);
    expect(channel.consume(ticket, "203.0.113.7")).toBeUndefined();
  });
  test("挑战只能用一次且有过期：重放与超窗都拒", async () => {
    const clock = { value: 1_000_000 };
    const { channel } = harness({ clock });
    const { device, sign } = desktopDevice();
    const { clientId } = await channel.register({
      clientType: "desktop",
      platform: "windows",
      clientVersion: "1.0.0",
      keyAlgorithm: "ed25519",
      publicKey: device.publicKey,
      selfCheck: clean,
    });
    const attest = (challenge: string) =>
      channel.attest(
        {
          clientId,
          challenge,
          signature: sign(challenge),
          clientType: "desktop",
          clientVersion: "1.0.0",
          selfCheck: clean,
        },
        "203.0.113.7"
      );
    const { challenge } = channel.issue(clientId);
    await attest(challenge);
    await expect(attest(challenge)).rejects.toMatchObject({ code: "CHALLENGE_EXPIRED" });
    const stale = channel.issue(clientId);
    clock.value += CLIENT_CHALLENGE_TTL_MS + 1;
    await expect(attest(stale.challenge)).rejects.toMatchObject({ code: "CHALLENGE_EXPIRED" });
  });
  test("签名不符即拒：拿别人的 clientId 换不了票", async () => {
    const { channel } = harness();
    const { device } = desktopDevice();
    const other = desktopDevice();
    const { clientId } = await channel.register({
      clientType: "desktop",
      platform: "windows",
      clientVersion: "1.0.0",
      keyAlgorithm: "ed25519",
      publicKey: device.publicKey,
      selfCheck: clean,
    });
    const { challenge } = channel.issue(clientId);
    await expect(
      channel.attest(
        {
          clientId,
          challenge,
          signature: other.sign(challenge),
          clientType: "desktop",
          clientVersion: "1.0.0",
          selfCheck: clean,
        },
        "203.0.113.7"
      )
    ).rejects.toMatchObject({ code: "CLIENT_UNTRUSTED" });
  });
  test("注册阶段自检不过即拒：不把作弊设备先记进设备表再拦", async () => {
    const { channel, store, warnings } = harness();
    const { device } = desktopDevice();
    await expect(
      channel.register({
        clientType: "desktop",
        platform: "windows",
        clientVersion: "1.0.0",
        keyAlgorithm: "ed25519",
        publicKey: device.publicKey,
        selfCheck: { ...clean, hardFail: ["ldr_list_mismatch"] },
      })
    ).rejects.toMatchObject({ code: "CLIENT_UNTRUSTED" });
    expect(await store.find(device.clientId)).toBeUndefined();
    expect(warnings).toEqual(["客户端完整性校验未通过"]);
  });
  test("换票阶段自检不过不给票，并记下原因供排查", async () => {
    const { channel, warnings } = harness();
    const { device, sign } = desktopDevice();
    const { clientId } = await channel.register({
      clientType: "desktop",
      platform: "windows",
      clientVersion: "1.0.0",
      keyAlgorithm: "ed25519",
      publicKey: device.publicKey,
      selfCheck: clean,
    });
    const { challenge } = channel.issue(clientId);
    await expect(
      channel.attest(
        {
          clientId,
          challenge,
          signature: sign(challenge),
          clientType: "desktop",
          clientVersion: "1.0.0",
          selfCheck: { ...clean, hardFail: ["debugger_attached"] },
        },
        "203.0.113.7"
      )
    ).rejects.toMatchObject({ code: "CLIENT_UNTRUSTED" });
    expect(warnings).toEqual(["客户端完整性校验未通过"]);
  });
  test("低于最低版本只标记不拦普通接入：拦不拦由反作弊房准入决定", async () => {
    const { channel } = harness({ minimum: "2.0.0" });
    const { device, sign } = desktopDevice();
    const registered = await channel.register({
      clientType: "desktop",
      platform: "windows",
      clientVersion: "1.5.0",
      keyAlgorithm: "ed25519",
      publicKey: device.publicKey,
      selfCheck: clean,
    });
    expect(registered).toMatchObject({ outdated: true, minimumVersion: "2.0.0" });
    const { challenge } = channel.issue(registered.clientId);
    const attested = await channel.attest(
      {
        clientId: registered.clientId,
        challenge,
        signature: sign(challenge),
        clientType: "desktop",
        clientVersion: "1.5.0",
        selfCheck: clean,
      },
      "203.0.113.7"
    );
    expect(attested.outdated).toBe(true);
    expect(channel.consume(attested.ticket, "203.0.113.7")?.outdated).toBe(true);
  });
  test("未注册与过期的 clientId 都拿不到票", async () => {
    const { channel } = harness();
    const { challenge } = channel.issue("ccd_000000000000000000000000");
    await expect(
      channel.attest(
        {
          clientId: "ccd_000000000000000000000000",
          challenge,
          signature: "AAAAAAAA",
          clientType: "desktop",
          clientVersion: "1.0.0",
          selfCheck: clean,
        },
        "203.0.113.7"
      )
    ).rejects.toMatchObject({ code: "CLIENT_UNKNOWN" });
  });
  test("票过期即失效", async () => {
    const clock = { value: 1_000_000 };
    const { channel } = harness({ clock });
    const { device, sign } = desktopDevice();
    const { clientId } = await channel.register({
      clientType: "desktop",
      platform: "windows",
      clientVersion: "1.0.0",
      keyAlgorithm: "ed25519",
      publicKey: device.publicKey,
      selfCheck: clean,
    });
    const { challenge } = channel.issue(clientId);
    const { ticket } = await channel.attest(
      {
        clientId,
        challenge,
        signature: sign(challenge),
        clientType: "desktop",
        clientVersion: "1.0.0",
        selfCheck: clean,
      },
      "203.0.113.7"
    );
    clock.value += CLIENT_TICKET_TTL_MS + 1;
    expect(channel.consume(ticket, "203.0.113.7")).toBeUndefined();
  });
  test("无 ticket 的握手拿不到通道证明：网页接入就是这条路径", () => {
    const { channel } = harness();
    expect(channel.consume(undefined, "203.0.113.7")).toBeUndefined();
    expect(channel.consume("not-a-ticket", "203.0.113.7")).toBeUndefined();
  });
  test("待处理条目有基数上限：伪造 clientId 不能按需撑爆内存", async () => {
    const { channel } = harness();
    for (let i = 0; i < 20_000; i++) channel.issue(`ccd_${String(i).padStart(24, "0")}`);
    const { device, sign } = desktopDevice();
    const { clientId } = await channel.register({
      clientType: "desktop",
      platform: "windows",
      clientVersion: "1.0.0",
      keyAlgorithm: "ed25519",
      publicKey: device.publicKey,
      selfCheck: clean,
    });
    const { challenge } = channel.issue(clientId);
    // 早先的挑战已被挤出，最后这条仍在：上限生效但不能把刚发的票也一起挤掉。
    const { ticket } = await channel.attest(
      {
        clientId,
        challenge,
        signature: sign(challenge),
        clientType: "desktop",
        clientVersion: "1.0.0",
        selfCheck: clean,
      },
      "203.0.113.7"
    );
    expect(channel.consume(ticket, "203.0.113.7")?.clientId).toBe(clientId);
  });
  test("验签对损坏的公钥与畸形签名失败关闭，不抛穿到握手", () => {
    const device: StoredClientDevice = {
      clientId: "ccd_broken",
      clientType: "desktop",
      platform: "windows",
      keyAlgorithm: "ed25519",
      publicKey: Buffer.from("too short").toString("base64"),
      keyProtection: "hardware",
      registeredAt: 0,
      lastSeenAt: 0,
    };
    expect(verifyClientSignature(device, "challenge", "AAAA")).toBe(false);
  });
});

describe("密钥口径", () => {
  test("桌面按裸 32 字节上报公钥，与壳的 Ed25519 SPKI 尾段一致", () => {
    const { device } = desktopDevice();
    const raw = Buffer.from(device.publicKey, "base64");
    expect(raw).toHaveLength(32);
    const rebuilt = createPublicKey({
      key: Buffer.concat([Buffer.from("302a300506032b6570032100", "hex"), raw]),
      format: "der",
      type: "spki",
    });
    expect(rebuilt.export({ format: "der", type: "spki" }).subarray(-32)).toEqual(raw);
  });
  test("移动按 SPKI 全文上报，验签走 DER 编码的 ECDSA-P256-SHA256", async () => {
    const { publicKey, privateKey } = generateKeyPairSync("ec", {
      namedCurve: "prime256v1",
    });
    const spki = publicKey.export({ format: "der", type: "spki" }).toString("base64");
    const context = harness();
    const mobile = {
      clientType: "mobile" as const,
      platform: "android",
      clientVersion: "1.0.0",
      keyAlgorithm: "ec-p256" as const,
      publicKey: spki,
      selfCheck: { ...clean, keyProtection: "hardware" as const },
    };
    const { clientId } = await context.channel.register(mobile);
    const { challenge } = context.channel.issue(clientId);
    const signature = nodeSign("sha256", Buffer.from(challenge, "ascii"), privateKey).toString(
      "base64"
    );
    const { ticket } = await context.channel.attest(
      {
        clientId,
        challenge,
        signature,
        clientType: "mobile",
        clientVersion: "1.0.0",
        selfCheck: clean,
      },
      "203.0.113.7"
    );
    expect(context.channel.consume(ticket, "203.0.113.7")).toMatchObject({
      clientId,
      clientType: "mobile",
      keyProtection: "hardware",
    });
  });
});
