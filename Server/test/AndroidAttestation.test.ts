import { describe, expect, test } from "bun:test";
import { createSign, generateKeyPairSync, randomBytes, type KeyObject } from "node:crypto";
import {
  ANDROID_ATTESTATION_STATUS_URL,
  createAndroidAttestationChecker,
  createRevocationCache,
  parseRevocationStatus,
  verifyAndroidAttestation,
  type RevocationSnapshot,
  type RevocationSource,
} from "../src/infrastructure/AndroidAttestation";

/**
 * 没有真实的 attestation 样本可离线取得，这里用自签测试 CA + 手写 DER 写出器把
 * `KeyDescription` 的 ASN.1 结构按 AOSP/Google 参考实现的口径拼出来，
 * 因此生产代码里的 DER 读取器与分档判定都被真实字节路径走通。
 */

const ECDSA_SHA256_OID = "1.2.840.10045.4.3.2";
const RSA_SHA1_OID = "1.2.840.113549.1.1.5";
const KEY_DESCRIPTION_OID = "1.3.6.1.4.1.11129.2.1.17";
const APPLICATION_ID_OID = "1.3.6.1.4.1.11129.2.1.16";

const NOW = Date.UTC(2026, 9, 19, 12, 0, 0);
/** 2021 年前出厂的工厂链窗口：notAfter 已过期，但按计划必须放行并标记。 */
const FACTORY_EXPIRED = Date.UTC(2020, 0, 1);

/* ------------------------------------------------------------------ DER 写出 */

const encode = (identifier: readonly number[], body: Buffer): Buffer => {
  const length = body.length;
  if (length < 0x80) return Buffer.concat([Buffer.from([...identifier, length]), body]);
  const bytes: number[] = [];
  let value = length;
  while (value > 0) {
    bytes.unshift(value & 0xff);
    value >>= 8;
  }
  return Buffer.concat([Buffer.from([...identifier, 0x80 | bytes.length, ...bytes]), body]);
};

const tlv = (tag: number, body: Buffer): Buffer => encode([tag], body);
const sequence = (...members: readonly Buffer[]): Buffer => tlv(0x30, Buffer.concat(members));
const setOf = (...members: readonly Buffer[]): Buffer => tlv(0x31, Buffer.concat(members));
const octetString = (body: Buffer): Buffer => tlv(0x04, body);
const enumerated = (value: number): Buffer => tlv(0x0a, Buffer.from([value]));

/** 上下文标签：编号 >30 走 base-128 续位（rootOfTrust=704、attestationApplicationId=709）。 */
const context = (tagNumber: number, body: Buffer): Buffer => {
  if (tagNumber < 31) return encode([0xa0 | tagNumber], body);
  const parts: number[] = [tagNumber & 0x7f];
  let value = tagNumber >> 7;
  while (value > 0) {
    parts.unshift((value & 0x7f) | 0x80);
    value >>= 7;
  }
  return encode([0xbf, ...parts], body);
};

/** 有符号 INTEGER：高位置 1 时要补 0x00 保持正数，验证读取侧的前导零归一。 */
const integer = (value: number): Buffer => {
  const bytes: number[] = [];
  let remaining = value;
  do {
    bytes.unshift(remaining & 0xff);
    remaining = Math.floor(remaining / 256);
  } while (remaining > 0);
  if ((bytes[0] & 0x80) === 0x80) bytes.unshift(0);
  return tlv(0x02, Buffer.from(bytes));
};

const oidBytes = (dotted: string): Buffer => {
  const parts = dotted.split(".").map(Number);
  const body: number[] = [parts[0] * 40 + parts[1]];
  for (const part of parts.slice(2)) {
    const stack: number[] = [];
    let value = part;
    do {
      stack.unshift(value & 0x7f);
      value >>= 7;
    } while (value > 0);
    for (let index = 0; index < stack.length - 1; index += 1) stack[index] |= 0x80;
    body.push(...stack);
  }
  return tlv(0x06, Buffer.from(body));
};

const utcTime = (epochMs: number): Buffer => {
  const date = new Date(epochMs);
  const pad = (value: number): string => String(value).padStart(2, "0");
  const text =
    pad(date.getUTCFullYear() % 100) +
    pad(date.getUTCMonth() + 1) +
    pad(date.getUTCDate()) +
    pad(date.getUTCHours()) +
    pad(date.getUTCMinutes()) +
    pad(date.getUTCSeconds()) +
    "Z";
  return tlv(0x17, Buffer.from(text, "ascii"));
};

const utf8Name = (commonName: string): Buffer =>
  sequence(setOf(sequence(oidBytes("2.5.4.3"), tlv(0x0c, Buffer.from(commonName, "utf8")))));

const toPem = (der: Buffer): Buffer | string => der.toString("base64").replace(/(.{64})/g, "$1\n");

const pemOf = (der: Buffer): string =>
  `-----BEGIN CERTIFICATE-----\n${toPem(der)}\n-----END CERTIFICATE-----\n`;

/* ------------------------------------------------------------------ 证书构造 */

interface KeyHolder {
  privateKey: KeyObject;
  publicKey: KeyObject;
  spki: Buffer;
  name: Buffer;
}

const ecKey = (commonName: string): KeyHolder => {
  const { privateKey, publicKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
  return {
    privateKey,
    publicKey,
    spki: publicKey.export({ type: "spki", format: "der" }) as Buffer,
    name: utf8Name(commonName),
  };
};

const rsaKey = (commonName: string): KeyHolder => {
  const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  return {
    privateKey,
    publicKey,
    spki: publicKey.export({ type: "spki", format: "der" }) as Buffer,
    name: utf8Name(commonName),
  };
};

interface CertInput {
  subject: KeyHolder;
  issuer: KeyHolder;
  /** 自签时 issuer === subject。 */
  serial: number;
  hash?: "sha1" | "sha256";
  signatureOid?: string;
  notBefore?: number;
  notAfter?: number;
  extensions?: readonly Buffer[];
  /** 用别的密钥签这张证书，用来固定「验签失败」路径。 */
  signedBy?: KeyHolder;
}

const extensionOf = (oid: string, value: Buffer, critical = false): Buffer =>
  sequence(
    oidBytes(oid),
    ...(critical ? [tlv(0x01, Buffer.from([0xff]))] : []),
    octetString(value)
  );

const buildCertificate = (input: CertInput): Buffer => {
  const notBefore = input.notBefore ?? Date.UTC(2018, 0, 1);
  const notAfter = input.notAfter ?? Date.UTC(2035, 0, 1);
  const signatureOid =
    input.signatureOid ?? (input.hash === "sha1" ? RSA_SHA1_OID : ECDSA_SHA256_OID);
  const algorithm = sequence(oidBytes(signatureOid));
  const tbs = sequence(
    tlv(0xa0, integer(2)),
    integer(input.serial),
    algorithm,
    input.issuer.name,
    sequence(utcTime(notBefore), utcTime(notAfter)),
    input.subject.name,
    input.subject.spki,
    ...(input.extensions && input.extensions.length > 0
      ? [tlv(0xa3, sequence(...input.extensions))]
      : [])
  );
  const signer = input.signedBy ?? input.issuer;
  const sign = createSign(input.hash ?? "sha256");
  sign.update(tbs);
  const signature = sign.sign(signer.privateKey);
  return sequence(tbs, algorithm, tlv(0x03, Buffer.concat([Buffer.from([0]), signature])));
};

/* ------------------------------------------------------- KeyDescription 构造 */

type SecurityLevel = 0 | 1 | 2;
type BootState = 0 | 1 | 2 | 3;

interface LeafEvidence {
  securityLevel: SecurityLevel;
  bootState: BootState;
  deviceLocked: boolean;
  /** 用非 DER 的 0xFF 表示 true，个别厂商就这么编。 */
  lockedEncoding?: "der" | "ff";
  packageName: string;
  signatureDigests: Buffer[];
  challenge: Buffer;
  /** RootOfTrust 放在 teeEnforced、softwareEnforced 还是两处都不放。 */
  rootOfTrustIn: "tee" | "software" | "none";
  /** applicationId 放在标签 709、只放 1.16 扩展，还是完全不放。 */
  applicationIdIn: "tee" | "software" | "legacy-extension" | "none";
}

const rootOfTrustOf = (
  evidence: LeafEvidence,
  bootKey = randomBytes(32),
  bootHash = randomBytes(32)
): Buffer =>
  sequence(
    octetString(bootKey),
    evidence.lockedEncoding === "ff"
      ? tlv(0x01, Buffer.from([0xff]))
      : tlv(0x01, Buffer.from([evidence.deviceLocked ? 0x01 : 0x00])),
    enumerated(evidence.bootState),
    octetString(bootHash)
  );

const applicationIdOf = (evidence: LeafEvidence): Buffer =>
  sequence(
    setOf(sequence(octetString(Buffer.from(evidence.packageName, "utf8")), integer(1))),
    setOf(...evidence.signatureDigests.map((digest) => octetString(digest)))
  );

const authorizationList = (members: readonly Buffer[]): Buffer => sequence(...members);

const buildKeyDescription = (evidence: LeafEvidence): Buffer => {
  const rootOfTrust =
    evidence.rootOfTrustIn === "none" ? [] : [context(704, octetString(rootOfTrustOf(evidence)))];
  const applicationId =
    evidence.applicationIdIn === "tee" || evidence.applicationIdIn === "software"
      ? [context(709, octetString(applicationIdOf(evidence)))]
      : [];
  const teeMembers = evidence.rootOfTrustIn === "tee" ? [...rootOfTrust, ...applicationId] : [];
  const softwareMembers =
    evidence.rootOfTrustIn === "software" ? [...rootOfTrust, ...applicationId] : [];
  return sequence(
    integer(400),
    enumerated(evidence.securityLevel),
    integer(400),
    enumerated(evidence.securityLevel),
    octetString(evidence.challenge),
    octetString(Buffer.alloc(0)),
    authorizationList(softwareMembers),
    authorizationList(teeMembers)
  );
};

interface ChainOptions extends Partial<LeafEvidence> {
  rootKind?: "hardware" | "software";
  /** `true` 时中间 CA 已过期，模拟 2021 前的工厂证书。 */
  factoryExpired?: boolean;
  sha1Signing?: boolean;
  /** 链里是否带上自签根（Keystore 原样返回会带）。 */
  includeRoot?: boolean;
  /** 在非叶子证书上也塞一个 attestation 扩展（拼接证明的攻击）。 */
  forgeIssuerExtension?: boolean;
  leafSerial?: number;
  issuerSerial?: number;
  rootSerial?: number;
  signedBy?: KeyHolder;
}

interface BuiltChain {
  chain: string[];
  hardwareRoots: string[];
  softwareRoots: string[];
  expectedDigest: string;
  challenge: Buffer;
  /** 叶子公钥的 SPKI base64：注册时要与它一致，链才绑得住这把密钥。 */
  leafSpki: string;
}

const DEFAULT_EVIDENCE: LeafEvidence = {
  securityLevel: 1,
  bootState: 0,
  deviceLocked: true,
  packageName: "website.baka.guessr",
  signatureDigests: [randomBytes(32)],
  challenge: randomBytes(32),
  rootOfTrustIn: "tee",
  applicationIdIn: "tee",
};

/** 搭一条 [叶子, 证明 CA, 根] 的链；信任锚按 hardware/software 分开交给调用方。 */
const buildChain = (options: ChainOptions = {}): BuiltChain => {
  const evidence: LeafEvidence = { ...DEFAULT_EVIDENCE, ...options };
  const rootKind = options.rootKind ?? "hardware";
  const root =
    rootKind === "software" ? ecKey("Software Attestation Root") : ecKey("Test Attestation Root");
  const issuer = ecKey(rootKind === "software" ? "Software Attestation CA" : "Test Attestation CA");
  const leaf = ecKey("Android Keystore Key");
  const signing = options.sha1Signing ? { hash: "sha1" as const, signatureOid: RSA_SHA1_OID } : {};
  const rootCert = buildCertificate({
    subject: root,
    issuer: root,
    serial: options.rootSerial ?? 0x9f23,
    ...signing,
  });
  const issuerCert = buildCertificate({
    subject: issuer,
    issuer: root,
    serial: options.issuerSerial ?? 0x4242,
    notAfter: options.factoryExpired ? FACTORY_EXPIRED : Date.UTC(2035, 0, 1),
    ...signing,
    ...(options.forgeIssuerExtension
      ? {
          extensions: [extensionOf(KEY_DESCRIPTION_OID, octetString(Buffer.from([0x30, 0x00])))],
        }
      : {}),
  });
  const applicationIdValue =
    evidence.applicationIdIn === "legacy-extension" ? applicationIdOf(evidence) : null;
  const leafExtensions = [
    extensionOf(KEY_DESCRIPTION_OID, buildKeyDescription(evidence), true),
    ...(applicationIdValue ? [extensionOf(APPLICATION_ID_OID, applicationIdValue)] : []),
  ];
  const leafCert = buildCertificate({
    subject: leaf,
    issuer: options.signedBy ?? issuer,
    serial: options.leafSerial ?? 0x01c4,
    signedBy: options.signedBy,
    ...signing,
    extensions: leafExtensions,
  });
  const path = [pemOf(leafCert), pemOf(issuerCert)];
  if (options.includeRoot !== false) path.push(pemOf(rootCert));
  return {
    chain: path,
    hardwareRoots: rootKind === "hardware" ? [pemOf(rootCert)] : [],
    softwareRoots: rootKind === "software" ? [pemOf(rootCert)] : [],
    expectedDigest: evidence.signatureDigests[0].toString("base64"),
    challenge: evidence.challenge,
    leafSpki: leaf.spki.toString("base64"),
  };
};

const snapshotOf = (
  entries: Record<string, string>,
  state: RevocationSnapshot["state"] = "fresh"
): RevocationSnapshot => ({
  entries: new Map(Object.entries(entries)),
  fetchedAt: NOW,
  state,
});

const sourceOf = (snapshot: RevocationSnapshot): RevocationSource => ({
  snapshot: async () => snapshot,
});

const verify = (
  built: BuiltChain,
  overrides: Record<string, unknown> = {},
  snapshot?: RevocationSnapshot
) =>
  verifyAndroidAttestation(
    {
      chain: built.chain,
      expectedChallenge: built.challenge,
      expectedPackageName: DEFAULT_EVIDENCE.packageName,
      expectedSignatureDigests: [built.expectedDigest],
      now: NOW,
      ...overrides,
    },
    {
      revocation: sourceOf(snapshot ?? snapshotOf({})),
      hardwareRoots: built.hardwareRoots,
      softwareRoots: built.softwareRoots,
    }
  );

/* -------------------------------------------------------------------- 用例 */

describe("Android Key Attestation 链验证", () => {
  test("硬件链 + Verified + 未吊销 + 摘要匹配 → trusted", async () => {
    const verdict = await verify(buildChain());
    expect(verdict.level).toBe("trusted");
    expect(verdict.reasons).toEqual([]);
    expect(verdict.securityLevel).toBe("trusted_environment");
    expect(verdict.verifiedBootState).toBe("verified");
    expect(verdict.deviceLocked).toBe(true);
    expect(verdict.rootKind).toBe("hardware");
  });

  test("叶子公钥必须就是注册那把：合法链不能转借给别的密钥", async () => {
    const built = buildChain();
    expect((await verify(built, { expectedPublicKey: built.leafSpki })).level).toBe("trusted");
    const stolen = await verify(built, {
      expectedPublicKey: ecKey("另一把设备密钥").spki.toString("base64"),
    });
    expect(stolen.level).toBe("rejected");
    expect(stolen.reasons).toEqual(["leaf_key_mismatch"]);
  });

  test("装配器把注册公钥接成链上绑定，结论仍按三档给", async () => {
    const built = buildChain();
    const check = createAndroidAttestationChecker({
      packageName: DEFAULT_EVIDENCE.packageName,
      signatureDigests: [built.expectedDigest],
      hardwareRoots: built.hardwareRoots,
      softwareRoots: built.softwareRoots,
      revocation: sourceOf(snapshotOf({})),
      now: () => NOW,
    });
    const report = {
      chain: built.chain,
      attestationChallenge: built.challenge.toString("base64"),
    };
    expect((await check({ ...report, publicKey: built.leafSpki })).level).toBe("trusted");
    expect(
      (await check({ ...report, publicKey: ecKey("冒用").spki.toString("base64") })).reasons
    ).toEqual(["leaf_key_mismatch"]);
  });

  test("StrongBox 与 TEE 同级进 trusted", async () => {
    const verdict = await verify(buildChain({ securityLevel: 2 }));
    expect(verdict.level).toBe("trusted");
    expect(verdict.securityLevel).toBe("strongbox");
  });

  test("链不含自签根时按 DN + 验签锚定", async () => {
    const built = buildChain({ includeRoot: false });
    const verdict = await verify(built);
    expect(verdict.level).toBe("trusted");
  });

  test("SecurityLevel = Software（锚到软件根）→ degraded", async () => {
    const verdict = await verify(buildChain({ rootKind: "software", securityLevel: 0 }));
    expect(verdict.level).toBe("degraded");
    expect(verdict.reasons).toContain("software_security_level");
    expect(verdict.rootKind).toBe("software");
  });

  test("软件根上报硬件强度 → rejected", async () => {
    const verdict = await verify(buildChain({ rootKind: "software", securityLevel: 1 }));
    expect(verdict.level).toBe("rejected");
    expect(verdict.reasons).toEqual(["security_level_root_mismatch"]);
  });

  test("2021 年前工厂证书已过期 → degraded，不拒绝", async () => {
    const verdict = await verify(buildChain({ factoryExpired: true }));
    expect(verdict.level).toBe("degraded");
    expect(verdict.reasons).toContain("certificate_expired");
  });

  test("SHA-1 老工厂链仍能验签，只记弱哈希标记", async () => {
    const built = buildChain({ sha1Signing: true });
    const rsa = rsaKey("Test Attestation RSA Root");
    expect(await verifyRsaChain(rsa, built)).toMatchObject({
      reasons: expect.arrayContaining(["weak_signature_hash"]),
    });
  });

  test("RootOfTrust 只编在 softwareEnforced 时也认", async () => {
    const verdict = await verify(buildChain({ rootOfTrustIn: "software" }));
    expect(verdict.level).toBe("trusted");
  });

  test("applicationId 只出现在 1.16 扩展（老 Keymaster）时也认", async () => {
    const verdict = await verify(buildChain({ applicationIdIn: "legacy-extension" }));
    expect(verdict.level).toBe("trusted");
  });

  test("CRL 不可用 → degraded 并记录警告", async () => {
    const warnings: string[] = [];
    const verdict = await verifyAndroidAttestation(
      {
        chain: [],
        expectedChallenge: Buffer.alloc(0),
        expectedPackageName: "website.baka.guessr",
      },
      { revocation: sourceOf(snapshotOf({}, "unavailable")), onWarn: (m) => warnings.push(m) }
    );
    expect(verdict.level).toBe("rejected");
    expect(warnings).toHaveLength(1);
  });

  test("CRL 过期（stale）时仍按已知数据判：吊销命中照样拒绝", async () => {
    const built = buildChain();
    const verdict = await verify(built, {}, snapshotOf({ "1c4": "revoked" }, "stale"));
    expect(verdict.level).toBe("rejected");
    expect(verdict.reasons).toEqual(["certificate_revoked"]);
  });

  test("CRL 从未拉到：放行但 degraded + crl_unavailable", async () => {
    const warnings: string[] = [];
    const verdict = await verify(buildChain(), {}, snapshotOf({}, "unavailable"));
    expect(verdict.level).toBe("degraded");
    expect(verdict.reasons).toContain("crl_unavailable");
    expect(warnings).toEqual([]);
  });

  test("链上任一证书被吊销 → rejected，序列号大小写与前导零都归一", async () => {
    const built = buildChain({ leafSerial: 0x8abf, issuerSerial: 0x01c4 });
    const uppercase = await verify(built, {}, snapshotOf({ "0001C4": "REVOKED" }));
    expect(uppercase.reasons).toEqual(["certificate_revoked"]);
    const leafHit = await verify(built, {}, snapshotOf({ "8abf": "SUSPENDED" }));
    expect(leafHit.level).toBe("rejected");
  });

  test("非吊销状态（REKEY）只标记异常", async () => {
    const verdict = await verify(
      buildChain({ issuerSerial: 0x01c4 }),
      {},
      snapshotOf({ "1c4": "rekey" })
    );
    expect(verdict.level).toBe("degraded");
    expect(verdict.reasons).toContain("certificate_status_abnormal");
  });

  test("boot 状态非 Verified → rejected", async () => {
    for (const [bootState, reason] of [
      [1, "boot_state_self_signed"],
      [2, "boot_state_unverified"],
      [3, "boot_state_failed"],
    ] as const) {
      const verdict = await verify(buildChain({ bootState }));
      expect(verdict.level).toBe("rejected");
      expect(verdict.reasons).toEqual([reason]);
    }
  });

  test("bootloader 解锁 → rejected", async () => {
    const verdict = await verify(buildChain({ deviceLocked: false }));
    expect(verdict.level).toBe("rejected");
    expect(verdict.reasons).toEqual(["bootloader_unlocked"]);
  });

  test("deviceLocked 用 0xFF 编码仍算锁定", async () => {
    const verdict = await verify(buildChain({ lockedEncoding: "ff" }));
    expect(verdict.level).toBe("trusted");
    expect(verdict.deviceLocked).toBe(true);
  });

  test("缺少 RootOfTrust → rejected", async () => {
    const verdict = await verify(buildChain({ rootOfTrustIn: "none" }));
    expect(verdict.reasons).toEqual(["missing_root_of_trust"]);
  });

  test("挑战 nonce 不符 → rejected", async () => {
    const built = buildChain();
    const verdict = await verify(built, { expectedChallenge: randomBytes(32) });
    expect(verdict.level).toBe("rejected");
    expect(verdict.reasons).toEqual(["challenge_mismatch"]);
  });

  test("包名不符 → rejected", async () => {
    const verdict = await verify(buildChain(), { expectedPackageName: "com.other.app" });
    expect(verdict.reasons).toEqual(["package_mismatch"]);
  });

  test("签名摘要不符（重打包）→ rejected", async () => {
    const verdict = await verify(buildChain(), {
      expectedSignatureDigests: [randomBytes(32).toString("base64")],
    });
    expect(verdict.level).toBe("rejected");
    expect(verdict.reasons).toEqual(["signature_digest_mismatch"]);
  });

  test("未配置期望签名摘要 → 封顶 degraded", async () => {
    const verdict = await verify(buildChain(), { expectedSignatureDigests: [] });
    expect(verdict.level).toBe("degraded");
    expect(verdict.reasons).toContain("signature_digest_unverified");
  });

  test("根不在信任库 → rejected", async () => {
    const built = buildChain();
    const other = buildChain();
    const verdict = await verifyAndroidAttestation(
      {
        chain: built.chain,
        expectedChallenge: built.challenge,
        expectedPackageName: DEFAULT_EVIDENCE.packageName,
        expectedSignatureDigests: [built.expectedDigest],
        now: NOW,
      },
      {
        revocation: sourceOf(snapshotOf({})),
        hardwareRoots: other.hardwareRoots,
        softwareRoots: [],
      }
    );
    expect(verdict.level).toBe("rejected");
    expect(verdict.reasons).toEqual(["untrusted_root_or_bad_signature"]);
  });

  test("叶子由别的密钥签发 → rejected", async () => {
    const rogue = ecKey("Rogue CA");
    const built = buildChain({ signedBy: rogue });
    const verdict = await verify(built);
    expect(verdict.level).toBe("rejected");
    expect(verdict.reasons).toEqual(["untrusted_root_or_bad_signature"]);
  });

  test("非叶子证书带 attestation 扩展 → rejected", async () => {
    const verdict = await verify(buildChain({ forgeIssuerExtension: true }));
    expect(verdict.reasons).toEqual(["attestation_extension_after_leaf"]);
  });

  test("叶子缺 KeyDescription 扩展 / 链过短 / 非证书 PEM → rejected", async () => {
    expect(
      (
        await verifyAndroidAttestation(
          {
            chain: ["-----BEGIN CERTIFICATE-----\nMA==\n-----END CERTIFICATE-----\n"],
            expectedChallenge: Buffer.alloc(0),
            expectedPackageName: "x",
          },
          { revocation: sourceOf(snapshotOf({})) }
        )
      ).reasons
    ).toEqual(["chain_too_short"]);
    const verdict = await verifyAndroidAttestation(
      {
        chain: ["not a pem", "still not a pem"],
        expectedChallenge: Buffer.alloc(0),
        expectedPackageName: "x",
      },
      { revocation: sourceOf(snapshotOf({})) }
    );
    expect(verdict.level).toBe("rejected");
    expect(verdict.reasons).toEqual(["malformed_attestation"]);
  });

  test("吊销判定覆盖信任锚自身", async () => {
    const built = buildChain({ rootSerial: 0x7777 });
    const verdict = await verify(built, {}, snapshotOf({ "7777": "revoked" }));
    expect(verdict.reasons).toEqual(["certificate_revoked"]);
  });
});

describe("Google 吊销状态列表", () => {
  test("entries 与 status 两种容器都解析，OK 项被丢弃", () => {
    const entries = parseRevocationStatus(
      JSON.stringify({
        entries: {
          "1C4": { status: "REVOKED" },
          "2F": { status: "OK" },
          "33": { status: "rekey" },
        },
      })
    );
    expect([...entries]).toEqual([
      ["1c4", "revoked"],
      ["33", "rekey"],
    ]);
    expect(
      parseRevocationStatus(JSON.stringify({ status: { abc: { status: "SUSPENDED" } } })).get("abc")
    ).toBe("suspended");
  });

  test("结构不正确或顶层是数组时抛错，让缓存层沿用旧快照", () => {
    expect(() => parseRevocationStatus("{}")).toThrow(/容器/);
    expect(() => parseRevocationStatus("[]")).toThrow(/顶层/);
    expect(() => parseRevocationStatus("not json")).toThrow(SyntaxError);
  });

  test("首次拉取成功后缓存，TTL 内不再回源", async () => {
    let calls = 0;
    const cache = createRevocationCache({
      fetcher: async () => {
        calls += 1;
        return new Response(JSON.stringify({ entries: { "1c4": { status: "REVOKED" } } }));
      },
      now: () => NOW,
      ttlMs: 60_000,
    });
    const first = await cache.snapshot();
    const second = await cache.snapshot();
    expect(calls).toBe(1);
    expect(first.state).toBe("fresh");
    expect(second.entries.get("1c4")).toBe("revoked");
  });

  test("拉取失败沿用上一次缓存并记警告：既不整片放行也不整片拒绝", async () => {
    let mode = "ok";
    let clockValue = NOW;
    const warnings: string[] = [];
    const cache = createRevocationCache({
      fetcher: async () =>
        mode === "ok"
          ? new Response(JSON.stringify({ entries: { dead: { status: "REVOKED" } } }))
          : Promise.reject(new Error("connect failed")),
      now: () => clockValue,
      ttlMs: 60_000,
      onWarn: (message) => warnings.push(message),
    });
    expect((await cache.snapshot()).state).toBe("fresh");
    mode = "fail";
    clockValue = NOW + 120_000; // 越过 TTL：下一次判定触发回源，回源失败。
    const stale = await cache.snapshot();
    expect(stale.state).toBe("stale");
    expect(stale.entries.get("dead")).toBe("revoked");
    expect(warnings.length).toBeGreaterThan(0);
    // 从未成功过的缓存：失败后是 unavailable（空名单 + 降级标记），而不是「全部已吊销」。
    const staleCache = createRevocationCache({
      fetcher: async () => {
        throw new Error("boom");
      },
      now: () => NOW,
      ttlMs: 60_000,
    });
    expect((await staleCache.snapshot()).state).toBe("unavailable");
  });

  test("非 200 响应不污染缓存", async () => {
    const cache = createRevocationCache({
      fetcher: async () => new Response("nope", { status: 503 }),
      now: () => NOW,
    });
    const snapshot = await cache.snapshot();
    expect(snapshot.state).toBe("unavailable");
    expect(snapshot.entries.size).toBe(0);
  });

  test("并发判定只发一次请求", async () => {
    let calls = 0;
    const cache = createRevocationCache({
      fetcher: async () => {
        calls += 1;
        await Promise.resolve();
        return new Response(JSON.stringify({ entries: {} }));
      },
      now: () => NOW,
    });
    const [a, b] = await Promise.all([cache.snapshot(), cache.snapshot()]);
    expect(calls).toBe(1);
    expect(a.state).toBe("fresh");
    expect(b.state).toBe("fresh");
  });

  test("超过大小上限的响应被取消并保留旧快照", async () => {
    const cache = createRevocationCache({
      fetcher: async () =>
        new Response(
          new ReadableStream({
            start(controller) {
              for (let index = 0; index < 40; index += 1)
                controller.enqueue(new Uint8Array(1024).fill(97));
              controller.close();
            },
          })
        ),
      now: () => NOW,
      maxBytes: 4096,
    });
    expect((await cache.snapshot()).state).toBe("unavailable");
  });

  test("缺省地址就是 Google 的状态列表端点", () => {
    expect(ANDROID_ATTESTATION_STATUS_URL).toBe(
      "https://android.googleapis.com/attestation/status"
    );
  });
});

/* ------------------------------------------------------------ 辅助与真实链 */

/** 用 RSA-2048 + SHA-1 造一条老工厂链，固定「弱哈希只降级」这条口径。 */
const verifyRsaChain = async (
  root: KeyHolder,
  built: BuiltChain
): Promise<{ reasons: string[]; level: string }> => {
  const issuer = rsaKey("Test Attestation RSA CA");
  const leaf = ecKey("Android Keystore Key");
  const evidence: LeafEvidence = { ...DEFAULT_EVIDENCE, challenge: built.challenge };
  const rootCert = buildCertificate({
    subject: root,
    issuer: root,
    serial: 0x9f23,
    signatureOid: RSA_SHA1_OID,
    hash: "sha1",
  });
  const issuerCert = buildCertificate({
    subject: issuer,
    issuer: root,
    serial: 0x4242,
    signatureOid: RSA_SHA1_OID,
    hash: "sha1",
  });
  const leafCert = buildCertificate({
    subject: leaf,
    issuer,
    serial: 0x01c4,
    extensions: [extensionOf(KEY_DESCRIPTION_OID, buildKeyDescription(evidence), true)],
  });
  const verdict = await verifyAndroidAttestation(
    {
      chain: [pemOf(leafCert), pemOf(issuerCert), pemOf(rootCert)],
      expectedChallenge: evidence.challenge,
      expectedPackageName: evidence.packageName,
      expectedSignatureDigests: [evidence.signatureDigests[0].toString("base64")],
      now: NOW,
    },
    { revocation: sourceOf(snapshotOf({})), hardwareRoots: [pemOf(rootCert)], softwareRoots: [] }
  );
  return { reasons: verdict.reasons, level: verdict.level };
};
