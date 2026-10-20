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
  type ClientAttestationLevel,
  type ClientRegisterInput,
  type ClientSelfCheckReport,
  type StoredClientDevice,
} from "../src/infrastructure/ClientChannel";
import type { AndroidAttestationChecker } from "../src/infrastructure/AndroidAttestation";

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

function harness(
  options: {
    clock?: { value: number };
    minimum?: string;
    attestation?: AndroidAttestationChecker;
  } = {}
) {
  const clock = options.clock ?? { value: 1_000_000 };
  const warnings: string[] = [];
  const store = new InMemoryClientChannelStore();
  const channel = new ClientChannel({
    store,
    now: () => clock.value,
    minimumVersion: () => options.minimum ?? "",
    onWarn: (message) => warnings.push(message),
    attestation: options.attestation,
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
    expect(judgeSelfCheck({ ...clean, hardFail: ["root_new_probe"] }).trusted).toBe(false);
  });
  test("检测跑不动的平台：放行但标可疑，不当成「跑过且干净」", () => {
    expect(judgeSelfCheck({ ...clean, hardFail: ["platform_unsupported"] })).toEqual({
      trusted: true,
      integrity: "suspect",
    });
  });
  test("移动端硬失败认冒号前的前缀：带包名/路径后缀一样拒", () => {
    for (const id of [
      "accessibility_automation:org.autojs.autojs/ScriptService",
      "root_su:/sbin/su",
      "root_magisk:/data/adb/modules",
      "emulator_build",
      "emulator_no_accelerometer",
      "clone_source_path",
      "keystore_unavailable",
    ])
      expect(judgeSelfCheck({ ...clean, hardFail: [id] }).trusted).toBe(false);
  });
  test("读屏用户不该被误伤：未知无障碍服务只是一条软失败", () => {
    expect(
      judgeSelfCheck({
        ...clean,
        softFail: ["accessibility_unknown:com.vendor.accessibility/.VoiceService"],
      })
    ).toEqual({ trusted: true, integrity: "suspect" });
    // 两条软失败才拒：x86 架构 + 缺陀螺仪的低端真机还在放行范围内，第三条撞线。
    expect(
      judgeSelfCheck({ ...clean, softFail: ["accessibility_unknown:a/b", "abi_x86"] }).trusted
    ).toBe(false);
  });
  test("按权重判不按壳填的格子：硬失败塞进 softFail 一样拒", () => {
    expect(judgeSelfCheck({ ...clean, softFail: ["root_test_keys"] }).trusted).toBe(false);
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
  test("被拒的票留下可归因日志：地址不符、未知与过期分开记", async () => {
    const clock = { value: 1_000_000 };
    const { channel, warnings } = harness({ clock });
    const { device, sign } = desktopDevice();
    const { clientId } = await channel.register({
      clientType: "desktop",
      platform: "windows",
      clientVersion: "1.0.0",
      keyAlgorithm: "ed25519",
      publicKey: device.publicKey,
      selfCheck: clean,
    });
    const attest = async () => {
      const { challenge } = channel.issue(clientId);
      return (
        await channel.attest(
          {
            clientId,
            challenge,
            signature: sign(challenge),
            clientType: "desktop",
            clientVersion: "1.0.0",
            selfCheck: clean,
          },
          "203.0.113.7"
        )
      ).ticket;
    };
    const wrongIp = await attest();
    expect(channel.consume(wrongIp, "198.51.100.9")).toBeUndefined();
    expect(warnings).toContain("客户端通道票据来源地址不符");
    // 地址不符不销毁票：口径一致后再来一次仍能换到证明。
    expect(channel.consume(wrongIp, "203.0.113.7")?.clientId).toBe(clientId);
    expect(channel.consume("not-a-ticket", "203.0.113.7")).toBeUndefined();
    expect(warnings).toContain("客户端通道票据无效或已被使用");
    const expired = await attest();
    clock.value += CLIENT_TICKET_TTL_MS + 1;
    expect(channel.consume(expired, "203.0.113.7")).toBeUndefined();
    expect(warnings).toContain("客户端通道票据已过期");
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

describe("移动端自检词表接入", () => {
  const mobileRegister = (selfCheck: ClientSelfCheckReport): ClientRegisterInput => ({
    clientType: "mobile",
    platform: "android",
    clientVersion: "1.0.0",
    keyAlgorithm: "ec-p256",
    publicKey: Buffer.from("spki-of-an-android-device").toString("base64"),
    selfCheck,
  });

  test("开了读屏的真机注册得进来：未知无障碍服务不算是作弊证据", async () => {
    const { channel, warnings } = harness();
    const { clientId } = await channel.register(
      mobileRegister({
        ...clean,
        softFail: ["accessibility_unknown:com.vendor.voiceread/.Service"],
      })
    );
    expect(clientId).toMatch(/^ccd_/);
    expect(warnings).toContain("客户端以可疑状态注册");
  });
  test("自动化外挂与模拟器在注册这一关就拒：不等到握手才发现", async () => {
    for (const id of [
      "accessibility_automation:org.autojs.autojspro/ScriptService",
      "emulator_build",
      "root_magisk:/data/adb/magisk",
    ]) {
      const { channel, store, warnings } = harness();
      const input = mobileRegister({ ...clean, hardFail: [id] });
      await expect(channel.register(input)).rejects.toMatchObject({ code: "CLIENT_UNTRUSTED" });
      await expect(store.find(clientIdOfPublicKey(input.publicKey))).resolves.toBeUndefined();
      expect(warnings).toContain("客户端完整性校验未通过");
    }
  });
});

describe("Android 平台证明接入", () => {
  // 通道这层不解析 DER，链只是透传；结构正确性由 `AndroidAttestation` 自己的用例覆盖。
  const chain = ["-----BEGIN CERTIFICATE-----\nMA==\n-----END CERTIFICATE-----\n"];
  const report = { chain, attestationChallenge: "AQIDBAU=" };
  const mobileRegister = (over: Partial<ClientRegisterInput> = {}): ClientRegisterInput => ({
    clientType: "mobile",
    platform: "android",
    clientVersion: "1.0.0",
    keyAlgorithm: "ec-p256",
    publicKey: Buffer.from("spki-of-this-device").toString("base64"),
    selfCheck: { ...clean, keyProtection: "hardware" },
    ...over,
  });
  const checker =
    (level: ClientAttestationLevel, reasons: string[] = []): AndroidAttestationChecker =>
    async () => ({ level, reasons });

  test("链判 rejected → 注册即拒，不给「解锁刷机的设备」留档", async () => {
    const { channel, store } = harness({
      attestation: checker("rejected", ["boot_state_unverified"]),
    });
    const input = mobileRegister({ attestation: report });
    await expect(channel.register(input)).rejects.toMatchObject({ code: "ATTESTATION_REJECTED" });
    await expect(store.find(clientIdOfPublicKey(input.publicKey))).resolves.toBeUndefined();
  });
  test("链判 trusted → 档位记进设备表，握手不重跑链验证", async () => {
    const { channel, store } = harness({ attestation: checker("trusted") });
    const input = mobileRegister({ attestation: report });
    const { clientId } = await channel.register(input);
    expect((await store.find(clientId))?.attestationLevel).toBe("trusted");
  });
  test("未配置校验器：链收下只记 degraded，并留一条警告", async () => {
    const { channel, store, warnings } = harness();
    const input = mobileRegister({ attestation: report });
    const { clientId } = await channel.register(input);
    expect((await store.find(clientId))?.attestationLevel).toBe("degraded");
    expect(warnings).toContain("收到 Android 证明链但服务端未配置校验");
  });
  test("校验器拿到的是本次注册的公钥：链必须绑得住这把密钥", async () => {
    const seen: string[] = [];
    const { channel } = harness({
      attestation: async (input) => {
        seen.push(`${input.publicKey}|${input.attestationChallenge}|${input.chain.length}`);
        return { level: "trusted", reasons: [] };
      },
    });
    const input = mobileRegister({ attestation: report });
    await channel.register(input);
    expect(seen).toEqual([`${input.publicKey}|${report.attestationChallenge}|1`]);
  });
  test("桌面端没有平台证明：混进链也不调用校验器，档位保持未验", async () => {
    let called = 0;
    const { channel, store } = harness({
      attestation: async (input) => {
        called += 1;
        return { level: input.publicKey ? "trusted" : "rejected", reasons: [] };
      },
    });
    const input = mobileRegister({ clientType: "desktop", attestation: report });
    const { clientId } = await channel.register(input);
    expect(called).toBe(0);
    expect((await store.find(clientId))?.attestationLevel).toBeUndefined();
  });
  test("档位以服务端验过的为准：壳自报 trusted 换不回一次被拒的证明", async () => {
    const { publicKey, privateKey } = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
    const raw = publicKey.export({ format: "der", type: "spki" }).toString("base64");
    const clientId = clientIdOfPublicKey(raw);
    const store = new InMemoryClientChannelStore();
    await store.save({
      clientId,
      clientType: "mobile",
      platform: "android",
      keyAlgorithm: "ec-p256",
      publicKey: raw,
      keyProtection: "hardware",
      attestationLevel: "rejected",
      registeredAt: 0,
      lastSeenAt: 0,
    });
    const channel = new ClientChannel({ store, minimumVersion: () => "" });
    const { challenge } = channel.issue(clientId);
    const signature = nodeSign("sha256", Buffer.from(challenge, "ascii"), privateKey).toString(
      "base64"
    );
    await expect(
      channel.attest(
        {
          clientId,
          challenge,
          signature,
          clientType: "mobile",
          clientVersion: "1.0.0",
          selfCheck: { ...clean, attestationLevel: "trusted" },
        },
        "203.0.113.7"
      )
    ).rejects.toMatchObject({ code: "CLIENT_UNTRUSTED" });
  });
});
