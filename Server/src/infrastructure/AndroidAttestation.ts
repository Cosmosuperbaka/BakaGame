import { createPublicKey, timingSafeEqual, verify as verifyDerSignature } from "node:crypto";
import {
  ANDROID_HARDWARE_ATTESTATION_ROOT_PEMS,
  ANDROID_SOFTWARE_ATTESTATION_ROOT_PEMS,
} from "./AndroidAttestationRoots";
import type { ClientAttestationCheckInput, ClientAttestationLevel } from "./ClientChannel";
import { isRecord } from "../shared/Json";

/**
 * Android Key Attestation 服务端验证。
 *
 * 为什么手写而不是用库：Google 推荐的是 JVM 侧 Kotlin 验证库，本仓库服务端是 Bun/Node；
 * `@peculiar/x509` 在这里只以 `@simplewebauthn/server` 传递依赖的形式躺在根 `node_modules`，
 * 两份 `package.json` 都没声明它（见 Conventions §4「消费端显式声明依赖」），不能拿来当根基；
 * 而且 `KeyDescription`（OID `1.3.6.1.4.1.11129.2.1.17`）里 ~50 个可选上下文字段仍需自定义 schema。
 * 于是验签与散列全部走 `node:crypto`，只有 ASN.1 结构是手写 DER 读取。
 *
 * 分档口径来自计划的失败矩阵，分界线是「设备完整性是否被破坏」而不是「证明强度够不够」：
 * - `trusted`：链可信 + 未吊销 + `verifiedBootState = Verified` + TEE/StrongBox；
 * - `degraded`：链可信但证明强度不足——Software 级、证书已过 X.509 有效期、CRL 暂不可用；
 * - `rejected`：验签或链名不符、根不受信、被吊销、boot 状态非 Verified、bootloader 解锁、
 *   包名或签名摘要对不上。
 *
 * 三处刻意的选择，改动前先读：
 * 1. **不按 X.509 有效期拒绝**。2021 年前出厂的工厂证书永久过期但仍可信（密钥无法轮换），
 *    RKP（Android 12 引入，Android 16 起只支持 RKP）证书本就短生命周期、到期换新。
 *    过期只降级留痕，一刀切拒绝会误伤整批老机型，也会把正常轮换的新设备判成异常。
 * 2. **CRL 拉不到时不整片放行也不整片拒绝**。沿用上一次成功的快照继续比吊销，只补一条降级标记。
 * 3. **不检查 `basicConstraints`/`keyUsage`**：与 Google 参考验证器一致，部分厂商链不严格遵守
 *    RFC 5280，加严只会把真实设备挡在门外；信任锚是内置固定的，多一层 CA 约束不改变结论。
 */

/** 叶子证书携带 `KeyDescription` 的扩展。 */
export const ANDROID_KEY_DESCRIPTION_OID = "1.3.6.1.4.1.11129.2.1.17";
/** 老设备上 `attestationApplicationId` 会以独立扩展出现（新设备放在授权列表标签 709 内）。 */
export const ANDROID_ATTESTATION_APPLICATION_ID_OID = "1.3.6.1.4.1.11129.2.1.16";
/** Google 的吊销状态列表（JSON），由服务端定时拉取并缓存。 */
export const ANDROID_ATTESTATION_STATUS_URL = "https://android.googleapis.com/attestation/status";

/** 授权列表里本模块关心的两个标签（Keymaster 与 KeyMint 编号一致）。 */
const TAG_ROOT_OF_TRUST = 704;
const TAG_ATTESTATION_APPLICATION_ID = 709;

export type AttestationSecurityLevel = "software" | "trusted_environment" | "strongbox";
export type VerifiedBootState = "verified" | "self_signed" | "unverified" | "failed";

const SECURITY_LEVELS: readonly AttestationSecurityLevel[] = [
  "software",
  "trusted_environment",
  "strongbox",
];
const BOOT_STATES: readonly VerifiedBootState[] = [
  "verified",
  "self_signed",
  "unverified",
  "failed",
];

/** 只有这两个状态算「已被吊销」；其余非 OK 值只标记异常，不误杀 REKEY 之类运维状态。 */
const REVOKING_STATUSES = new Set(["revoked", "suspended"]);

export interface RootOfTrust {
  deviceLocked: boolean;
  verifiedBootState: VerifiedBootState;
  /** `verifiedBootKey` 只在 boot 状态非 Verified 时才有解释意义，这里只保留原始字节。 */
  verifiedBootKey: Buffer;
  verifiedBootHash: Buffer | null;
}

export interface AttestationApplicationId {
  /** split APK 会有多个包名，包含判定用全集。 */
  packageNames: string[];
  /** 签名证书 DER 的摘要集合：重打包换签名后这里的值必然变化。 */
  signatureDigests: Buffer[];
}

export interface KeyDescription {
  securityLevel: AttestationSecurityLevel;
  keyMintSecurityLevel: AttestationSecurityLevel;
  attestationChallenge: Buffer;
  rootOfTrust: RootOfTrust | null;
  applicationId: AttestationApplicationId | null;
}

export interface AndroidAttestationRequest {
  /** PEM 数组，叶子在前。Keystore 返回的链含根，这里也接受裁掉根的写法。 */
  chain: readonly string[];
  /**
   * 服务端下发的挑战原样字节：客户端把它逐字交给 `setAttestationChallenge`。
   * 只收字节、不猜编码——base64 与十六进制字符集重叠，自动判别会把合法挑战读歪。
   * 挑战串按 UTF-8 送进 Keystore 时，调用方传 `Buffer.from(challenge, "utf8")`。
   */
  expectedChallenge: Uint8Array;
  expectedPackageName: string;
  /**
   * 本次注册的公钥（SPKI DER 的 base64/base64url）。挑战由设备自报、服务端没下发过 nonce，
   * 所以「链对应这把密钥」才是唯一的绑定；不给就没法把证明与密钥缝在一起。
   */
  expectedPublicKey?: string;
  /** 期望签名摘要，base64/base64url。不给就只验包名，结论最高只能到 `degraded`。 */
  expectedSignatureDigests?: readonly string[];
  /** 注入时钟（epoch 毫秒），缺省 `Date.now()`。 */
  now?: number;
}

export interface AndroidAttestationVerdict {
  level: ClientAttestationLevel;
  /**
   * 稳定机器码：`rejected` 时只有触发拒绝的那一条，`degraded` 时是全部降级原因，
   * `trusted` 时为空。调用方据此映射错误码与埋点。
   */
  reasons: string[];
  securityLevel?: AttestationSecurityLevel;
  verifiedBootState?: VerifiedBootState;
  deviceLocked?: boolean;
  /** 链最终锚定到哪一类根：软件根不具备硬件证明资格。 */
  rootKind?: "hardware" | "software";
  attestedPackageName?: string;
}

export interface RevocationSnapshot {
  /** 键为归一化（小写、去前导零）的十六进制序列号，值是小写状态串。 */
  entries: ReadonlyMap<string, string>;
  fetchedAt: number;
  /** `fresh` 在 TTL 内；`stale` 沿用上次成功结果；`unavailable` 从未成功拉取过。 */
  state: "fresh" | "stale" | "unavailable";
}

/** 吊销信息来源：生产用带缓存的抓取，测试注入固定快照。 */
export interface RevocationSource {
  snapshot(): Promise<RevocationSnapshot>;
}

export interface AndroidAttestationOptions {
  revocation: RevocationSource;
  hardwareRoots?: readonly string[];
  softwareRoots?: readonly string[];
  onWarn?: (message: string, detail?: string) => void;
}

/** DER 结构不合规统一走这里，最终映射成 `rejected`，绝不伪装成「放行但降级」。 */
class DerError extends Error {}

/* ---------------------------------------------------------------- DER 读取 */

interface Tlv {
  tagClass: number;
  tagNumber: number;
  /** 标识字节起点：验签要用 TBSCertificate 的原始编码，不能重新序列化。 */
  start: number;
  contentStart: number;
  contentEnd: number;
}

const CLASS_UNIVERSAL = 0;
const CLASS_CONTEXT = 2;

const TAG_BOOLEAN = 1;
const TAG_INTEGER = 2;
const TAG_BIT_STRING = 3;
const TAG_OCTET_STRING = 4;
const TAG_OID = 6;
const TAG_ENUMERATED = 10;
const TAG_SEQUENCE = 16;
const TAG_SET = 17;
const TAG_UTCTIME = 23;
const TAG_GENERALIZED_TIME = 24;

/** 解码 Length 字段，返回内容字节区间 `[start, end)`；调用方再核对是否越出缓冲区。 */
const readLength = (buf: Buffer, cursor: number): { start: number; end: number } => {
  if (cursor >= buf.length) throw new DerError("DER 长度缺失");
  const first = buf[cursor];
  let start = cursor + 1;
  if (first === 0x80) throw new DerError("不支持不定长编码");
  if (first < 0x80) return { start, end: start + first };
  const bytes = first & 0x7f;
  if (bytes > 4) throw new DerError("DER 长度字段过长");
  let length = 0;
  for (let index = 0; index < bytes; index += 1) {
    if (start >= buf.length) throw new DerError("DER 长度字段越界");
    length = (length << 8) | buf[start];
    start += 1;
  }
  return { start, end: start + length };
};

const readTlv = (buf: Buffer, offset: number): Tlv => {
  if (offset >= buf.length) throw new DerError("DER 读取越界");
  const first = buf[offset];
  const tagClass = first >> 6;
  let cursor = offset + 1;
  let tagNumber = first & 0x1f;
  if (tagNumber === 0x1f) {
    // 高标签号（>30）用 base-128 续位编码：rootOfTrust=704、attestationApplicationId=709 走的就是这条路。
    tagNumber = 0;
    for (;;) {
      if (cursor >= buf.length) throw new DerError("DER 标签不完整");
      const byte = buf[cursor];
      cursor += 1;
      tagNumber = (tagNumber << 7) | (byte & 0x7f);
      if ((byte & 0x80) === 0) break;
    }
  }
  const { start, end } = readLength(buf, cursor);
  if (end > buf.length) throw new DerError("DER 内容超出缓冲区");
  return { tagClass, tagNumber, start: offset, contentStart: start, contentEnd: end };
};

function* childrenOf(buf: Buffer, tlv: Tlv): Generator<Tlv> {
  let cursor = tlv.contentStart;
  while (cursor < tlv.contentEnd) {
    const child = readTlv(buf, cursor);
    yield child;
    cursor = child.contentEnd;
  }
}

const isUniversal = (tlv: Tlv | undefined, tag: number): boolean =>
  tlv !== undefined && tlv.tagClass === CLASS_UNIVERSAL && tlv.tagNumber === tag;

const isContext = (tlv: Tlv | undefined, tag: number): boolean =>
  tlv !== undefined && tlv.tagClass === CLASS_CONTEXT && tlv.tagNumber === tag;

const fullSlice = (buf: Buffer, tlv: Tlv): Buffer => buf.subarray(tlv.start, tlv.contentEnd);

const contentBytes = (buf: Buffer, tlv: Tlv): Buffer =>
  buf.subarray(tlv.contentStart, tlv.contentEnd);

const requireTag = (buf: Buffer, tlv: Tlv | undefined, tag: number, label: string): Buffer => {
  if (tlv === undefined || !isUniversal(tlv, tag))
    throw new DerError(`${label} 的 ASN.1 类型不正确`);
  return contentBytes(buf, tlv);
};

const requireChild = (children: readonly Tlv[], index: number, label: string): Tlv => {
  const tlv = children[index];
  if (!tlv) throw new DerError(`${label} 缺少第 ${index} 个字段`);
  return tlv;
};

const enumeratedValue = (buf: Buffer, tlv: Tlv, label: string): number => {
  let value = 0;
  for (const byte of requireTag(buf, tlv, TAG_ENUMERATED, label)) value = value * 256 + byte;
  return value;
};

const dottedOid = (bytes: Buffer): string => {
  if (bytes.length === 0) return "";
  const parts: number[] = [Math.floor(bytes[0] / 40), bytes[0] % 40];
  let accumulator = 0;
  for (let index = 1; index < bytes.length; index += 1) {
    accumulator = accumulator * 128 + (bytes[index] & 0x7f);
    if ((bytes[index] & 0x80) === 0) {
      parts.push(accumulator);
      accumulator = 0;
    }
  }
  return parts.join(".");
};

/**
 * 序列号归一化成「小写、无前导零」的十六进制。
 * Google 参考实现用 `BigInteger.toString(16)`，而证书里的 DER INTEGER 常带一个表示正数的
 * `00` 前缀；两侧都归一化才不会漏匹配吊销项。
 */
const serialHex = (bytes: Buffer): string => bytes.toString("hex").replace(/^0+/, "") || "0";

/**
 * BOOLEAN 取值：取最后一个内容字节。
 * 个别厂商把 `true` 编成 `0xFF`（不是 DER 最小形式），Google 的实现同样只看末字节；
 * 长度为 0（BER 的 FALSE 写法）按 `false`。
 */
const derBoolean = (bytes: Buffer): boolean => bytes.length > 0 && bytes[bytes.length - 1] !== 0;

const parseTime = (buf: Buffer, tlv: Tlv | undefined): number => {
  const utc = isUniversal(tlv, TAG_UTCTIME);
  if (!tlv) throw new DerError("证书缺少时间字段");
  if (!utc && !isUniversal(tlv, TAG_GENERALIZED_TIME)) throw new DerError("证书时间字段类型不正确");
  const text = contentBytes(buf, tlv).toString("ascii").trim();
  // UTCTIME 是两位年（后随字段前移 0 位），GENERALIZED_TIME 是四位年（多占 2 位）。
  const shift = utc ? 0 : 2;
  const rawYear = Number(text.slice(0, 2 + shift));
  // RFC 5280：两位年份 <50 归 20xx，>=50 归 19xx。
  const year = utc ? (rawYear < 50 ? 2000 + rawYear : 1900 + rawYear) : rawYear;
  return Date.UTC(
    year,
    Number(text.slice(2 + shift, 4 + shift)) - 1,
    Number(text.slice(4 + shift, 6 + shift)),
    Number(text.slice(6 + shift, 8 + shift)),
    Number(text.slice(8 + shift, 10 + shift)),
    Number(text.slice(10 + shift, 12 + shift))
  );
};

/* ---------------------------------------------------------------- 证书模型 */

interface AttestationCertificate {
  der: Buffer;
  /** TBSCertificate 的完整编码：验签对象是这段字节。 */
  tbs: Buffer;
  signature: Buffer;
  signatureAlgorithm: string;
  serial: string;
  issuer: Buffer;
  subject: Buffer;
  notBefore: number;
  notAfter: number;
  /** SubjectPublicKeyInfo 的完整编码，交给 `createPublicKey`。 */
  spki: Buffer;
  extensions: Map<string, { critical: boolean; value: Buffer }>;
}

/**
 * 签名算法 OID → `node:crypto` 摘要名；`null` 表示自带摘要的纯算法（Ed25519/Ed448）。
 * 表里没有的算法（ML-DSA 后量子链、带参 RSA-PSS 等）判为不支持并拒绝：验不了的签名不能当证明。
 * 日后要支持得先拿到真实设备链做固定用例，再扩这张表。
 */
const HASH_BY_SIGNATURE_OID: ReadonlyMap<string, string | null> = new Map([
  ["1.2.840.113549.1.1.5", "sha1"],
  ["1.2.840.113549.1.1.11", "sha256"],
  ["1.2.840.113549.1.1.12", "sha384"],
  ["1.2.840.113549.1.1.13", "sha512"],
  ["1.2.840.10045.4.1", "sha1"],
  ["1.2.840.10045.4.3.1", "sha224"],
  ["1.2.840.10045.4.3.2", "sha256"],
  ["1.2.840.10045.4.3.3", "sha384"],
  ["1.2.840.10045.4.3.4", "sha512"],
  ["1.3.101.112", null],
  ["1.3.101.111", null],
]);

/** SHA-1 仍要能验，因为老工厂链在用；但只允许降到 `degraded`，不给 `trusted`。 */
const WEAK_HASHES = new Set(["sha1"]);

const pemToDer = (pem: string): Buffer => {
  if (!pem.includes("BEGIN CERTIFICATE")) throw new DerError("链中出现非证书 PEM");
  const body = pem.replace(/-----[^-]+-----/g, "").replace(/\s+/g, "");
  if (body.length === 0) throw new DerError("证书 PEM 为空");
  return Buffer.from(body, "base64");
};

const parseExtensions = (
  buf: Buffer,
  wrapper: Tlv
): Map<string, { critical: boolean; value: Buffer }> => {
  const extensions = new Map<string, { critical: boolean; value: Buffer }>();
  const sequence = readTlv(buf, wrapper.contentStart);
  if (!isUniversal(sequence, TAG_SEQUENCE)) throw new DerError("扩展列表结构不正确");
  for (const entry of childrenOf(buf, sequence)) {
    const fields = [...childrenOf(buf, entry)];
    const oid = dottedOid(requireTag(buf, fields[0], TAG_OID, "扩展 OID"));
    const value = requireTag(buf, fields.at(-1), TAG_OCTET_STRING, "扩展值");
    if (!oid) continue;
    extensions.set(oid, {
      critical: fields.some((field) => isUniversal(field, TAG_BOOLEAN)),
      value,
    });
  }
  return extensions;
};

/**
 * 解析一张 X.509 证书。字段按 RFC 5280 的固定顺序逐个消费，
 * 所以 `[0] version`、`[1]/[2] uniqueID` 这类可选包装不会让后续字段错位。
 */
const parseCertificate = (der: Buffer): AttestationCertificate => {
  const outer = readTlv(der, 0);
  if (!isUniversal(outer, TAG_SEQUENCE)) throw new DerError("证书不是 SEQUENCE");
  const top = [...childrenOf(der, outer)];
  const tbs = requireChild(top, 0, "Certificate");
  const algorithmIdentifier = requireChild(top, 1, "Certificate");
  // BIT STRING 的首个内容是「未使用位数」，签名本身从第二字节开始。
  const signatureBytes = requireTag(
    der,
    requireChild(top, 2, "Certificate"),
    TAG_BIT_STRING,
    "签名值"
  );
  const fields = [...childrenOf(der, tbs)];
  // `[0] version` 是唯一的「有或没有」前缀项，跳过它之后其余字段位置固定。
  const base = isContext(fields[0], 0) ? 1 : 0;
  const serial = serialHex(
    requireTag(der, requireChild(fields, base, "TBSCertificate"), TAG_INTEGER, "序列号")
  );
  const issuer = contentBytes(der, requireChild(fields, base + 2, "TBSCertificate"));
  const validity = requireChild(fields, base + 3, "TBSCertificate");
  const subject = contentBytes(der, requireChild(fields, base + 4, "TBSCertificate"));
  const spki = fullSlice(der, requireChild(fields, base + 5, "TBSCertificate"));
  let tail = base + 6;
  if (isContext(fields[tail], 1)) tail += 1;
  if (isContext(fields[tail], 2)) tail += 1;
  const extensionField = fields[tail];
  const extensions = isContext(extensionField, 3)
    ? parseExtensions(der, extensionField)
    : new Map<string, { critical: boolean; value: Buffer }>();
  const times = [...childrenOf(der, validity)];
  return {
    der,
    tbs: fullSlice(der, tbs),
    signature: signatureBytes.subarray(1),
    signatureAlgorithm: dottedOid(
      requireTag(der, firstChild(der, algorithmIdentifier), TAG_OID, "签名算法")
    ),
    serial,
    issuer,
    subject,
    notBefore: parseTime(der, times[0]),
    notAfter: parseTime(der, times[1]),
    spki,
    extensions,
  };
};

const firstChild = (buf: Buffer, tlv: Tlv): Tlv => {
  const child = childrenOf(buf, tlv).next().value;
  if (!child) throw new DerError("AlgorithmIdentifier 为空");
  return child;
};

/* ------------------------------------------------------- KeyDescription 解析 */

const parseRootOfTrust = (bytes: Buffer): RootOfTrust => {
  const sequence = readTlv(bytes, 0);
  const fields = [...childrenOf(bytes, sequence)];
  if (fields.length !== 3 && fields.length !== 4) throw new DerError("RootOfTrust 字段数不正确");
  const state =
    BOOT_STATES[
      enumeratedValue(bytes, requireChild(fields, 2, "RootOfTrust"), "verifiedBootState")
    ];
  if (!state) throw new DerError("verifiedBootState 取值未知");
  return {
    verifiedBootKey: contentBytes(bytes, requireChild(fields, 0, "RootOfTrust")),
    deviceLocked: derBoolean(contentBytes(bytes, requireChild(fields, 1, "RootOfTrust"))),
    verifiedBootState: state,
    verifiedBootHash: fields.length > 3 ? contentBytes(bytes, fields[3]) : null,
  };
};

/**
 * `AttestationApplicationId ::= SEQUENCE { packageInfos, signatureDigests }`。
 * AOSP 文档写 SEQUENCE OF，Google 参考实现按 DER 编成 SET OF，两种标签设备上都出现过，
 * 只认一种就会把正常链判成结构异常。
 */
const parseApplicationId = (bytes: Buffer): AttestationApplicationId => {
  const sequence = readTlv(bytes, 0);
  if (!isUniversal(sequence, TAG_SEQUENCE))
    throw new DerError("AttestationApplicationId 结构不正确");
  const members = [...childrenOf(bytes, sequence)];
  const packageField = requireChild(members, 0, "AttestationApplicationId");
  const signatureField = requireChild(members, 1, "AttestationApplicationId");
  if (!isUniversal(packageField, TAG_SET) && !isUniversal(packageField, TAG_SEQUENCE))
    throw new DerError("packageInfos 容器类型不正确");
  const packageNames: string[] = [];
  for (const entry of childrenOf(bytes, packageField)) {
    const info = [...childrenOf(bytes, entry)];
    if (info.length === 2) packageNames.push(contentBytes(bytes, info[0]).toString("utf8"));
  }
  const signatureDigests: Buffer[] = [];
  for (const entry of childrenOf(bytes, signatureField)) {
    if (isUniversal(entry, TAG_OCTET_STRING)) signatureDigests.push(contentBytes(bytes, entry));
  }
  return { packageNames, signatureDigests };
};

/** 标签 704/709 的值都是「OCTET STRING 包一段 DER」，统一在这里拆两层包装。 */
const unbox = (buf: Buffer, field: Tlv, label: string): Buffer => {
  const inner = readTlv(buf, field.contentStart);
  // `requireTag` 已经返回 OCTET STRING 的内容字节，再剥一层会把内层 DER 切短。
  return requireTag(buf, inner, TAG_OCTET_STRING, label);
};

interface AuthorizationEntry {
  rootOfTrust: RootOfTrust | null;
  applicationId: AttestationApplicationId | null;
}

/**
 * 扫一遍授权列表取本模块关心的标签。
 * 未知标签直接跳过：KeyMint 会持续新增字段，硬拒绝会让新版 ROM 的正常链被判死。
 */
const readAuthorizationList = (buf: Buffer, tlv: Tlv): AuthorizationEntry => {
  if (!isUniversal(tlv, TAG_SEQUENCE)) throw new DerError("授权列表结构不正确");
  const entry: AuthorizationEntry = { rootOfTrust: null, applicationId: null };
  for (const field of childrenOf(buf, tlv)) {
    if (isContext(field, TAG_ROOT_OF_TRUST) && !entry.rootOfTrust)
      entry.rootOfTrust = parseRootOfTrust(unbox(buf, field, "rootOfTrust"));
    if (isContext(field, TAG_ATTESTATION_APPLICATION_ID) && !entry.applicationId)
      entry.applicationId = parseApplicationId(unbox(buf, field, "attestationApplicationId"));
  }
  return entry;
};

const parseKeyDescription = (value: Buffer): KeyDescription => {
  const sequence = readTlv(value, 0);
  if (!isUniversal(sequence, TAG_SEQUENCE)) throw new DerError("KeyDescription 结构不正确");
  const fields = [...childrenOf(value, sequence)];
  if (fields.length !== 8) throw new DerError("KeyDescription 字段数不正确");
  const securityLevel =
    SECURITY_LEVELS[enumeratedValue(value, fields[1], "attestationSecurityLevel")];
  const keyMintSecurityLevel =
    SECURITY_LEVELS[enumeratedValue(value, fields[3], "keymasterSecurityLevel")];
  if (!securityLevel || !keyMintSecurityLevel) throw new DerError("SecurityLevel 取值未知");
  const software = readAuthorizationList(value, fields[6]);
  const tee = readAuthorizationList(value, fields[7]);
  return {
    securityLevel,
    keyMintSecurityLevel,
    attestationChallenge: requireTag(value, fields[4], TAG_OCTET_STRING, "attestationChallenge"),
    // RootOfTrust 规范上只在硬件列表里，但个别机型把它编在软件列表；两处都兜住，再由档位与根类型收口。
    rootOfTrust: tee.rootOfTrust ?? software.rootOfTrust,
    applicationId: tee.applicationId ?? software.applicationId,
  };
};

/* --------------------------------------------------------------- 链与锚定 */

type LinkResult = "ok" | "signature_mismatch" | "unsupported_algorithm";

/**
 * 用签发者公钥验证上一张证书。`node:crypto` 抛错（算法与密钥不匹配等）与验签失败同属
 * 「这条链不成立」；算法不认识单独归因，方便按真实设备补支持。
 */
const verifyLink = (cert: AttestationCertificate, issuer: AttestationCertificate): LinkResult => {
  const hash = HASH_BY_SIGNATURE_OID.get(cert.signatureAlgorithm);
  if (hash === undefined) return "unsupported_algorithm";
  try {
    const key = createPublicKey({ key: issuer.spki, format: "der", type: "spki" });
    return verifyDerSignature(hash, cert.tbs, key, cert.signature) ? "ok" : "signature_mismatch";
  } catch {
    return "signature_mismatch";
  }
};

const verifyLinks = (
  path: readonly AttestationCertificate[],
  anchor: AttestationCertificate
): LinkResult => {
  let issuer = anchor;
  for (let index = path.length - 1; index >= 0; index -= 1) {
    const cert = path[index];
    // 名字链接比的是 DN 的原始 DER 字节：旧硬件根没有 CN，靠 DN 字符串匹配会误判。
    if (!cert.issuer.equals(issuer.subject)) return "signature_mismatch";
    const result = verifyLink(cert, issuer);
    if (result !== "ok") return result;
    issuer = cert;
  }
  return "ok";
};

interface AnchorMatch {
  kind: "hardware" | "software";
  /** 待验证链（不含信任锚本身）。 */
  path: AttestationCertificate[];
  anchor: AttestationCertificate;
}

/**
 * 逐跳验证并锚定到内置根。链尾既可能是自签根（Keystore 原样返回），也可能止于中间 CA
 * （客户端裁掉根）：前者按 DER 逐字节比对，后者按 DN + 验签。
 * 根自身不再验自签——字节相同已足以证明它就是内置的那一张。
 */
const buildChain = (
  chain: readonly AttestationCertificate[],
  anchors: readonly AttestationCertificate[],
  kind: "hardware" | "software"
): { match?: AnchorMatch; failure?: LinkResult } => {
  let failure: LinkResult | undefined;
  for (const anchor of anchors) {
    const last = chain.at(-1);
    const included = last !== undefined && last.der.equals(anchor.der);
    const path = included ? chain.slice(0, -1) : [...chain];
    const result = verifyLinks(path, anchor);
    if (result === "ok") return { match: { kind, path, anchor } };
    if (result === "unsupported_algorithm") failure = result;
  }
  return { failure };
};

const usesWeakHash = (certs: readonly AttestationCertificate[]): boolean =>
  certs.some((cert) => WEAK_HASHES.has(HASH_BY_SIGNATURE_OID.get(cert.signatureAlgorithm) ?? ""));

const bytesEqual = (left: Buffer, right: Buffer): boolean =>
  left.length === right.length && timingSafeEqual(left, right);

const base64ToBytes = (value: string): Buffer =>
  Buffer.from(value.trim().replace(/-/g, "+").replace(/_/g, "/"), "base64");

const normalizeCrlKey = (value: string): string =>
  value.trim().toLowerCase().replace(/^0x/, "").replace(/^0+/, "") || "0";

interface RevocationHit {
  serial: string;
  status: string;
}

/**
 * 序列号索引：键与状态两侧都归一化。
 * `parseRevocationStatus` 产出的键本来就是归一化的，这里等于再过一遍恒等变换；
 * 归一化真正兜住的是测试/运维注入的快照（大写、带 `0x` 或前导零都不该漏匹配）。
 * 以 `Map` 对象为 WeakMap 键做记忆：生产缓存每次快照复用同一个 `entries`，只建一次索引。
 */
const revocationIndex = new WeakMap<ReadonlyMap<string, string>, Map<string, string>>();

const normalizedRevocations = (entries: ReadonlyMap<string, string>): Map<string, string> => {
  const cached = revocationIndex.get(entries);
  if (cached) return cached;
  const index = new Map<string, string>();
  for (const [serial, status] of entries) {
    const value = status.toLowerCase();
    if (value) index.set(normalizeCrlKey(serial), value);
  }
  revocationIndex.set(entries, index);
  return index;
};

/** 吊销匹配范围含链尾根证书：Google 的状态列表里确实登记过 CA 的序列号。 */
const findRevocation = (
  chain: readonly AttestationCertificate[],
  snapshot: RevocationSnapshot
): RevocationHit | null => {
  if (snapshot.entries.size === 0) return null;
  const index = normalizedRevocations(snapshot.entries);
  for (const cert of chain) {
    const status = index.get(cert.serial);
    if (status) return { serial: cert.serial, status };
  }
  return null;
};

/* ----------------------------------------------------------------- 判定流程 */

interface VerifiedChain {
  description: KeyDescription;
  /** 参与吊销与有效期判定的全部证书，含信任锚。 */
  audited: AttestationCertificate[];
  rootKind: "hardware" | "software";
}

interface Evidence {
  description?: KeyDescription;
  rootKind?: "hardware" | "software";
}

type Collected =
  { chain: VerifiedChain } | { failure: string; evidence: Evidence; detail?: string };

const parseRootPems = (pems: readonly string[]): AttestationCertificate[] =>
  pems.map((pem) => parseCertificate(pemToDer(pem)));

/** 解析链、取 KeyDescription、核对挑战并锚定信任根；失败只回拒绝原因。 */
const collectEvidence = (
  request: AndroidAttestationRequest,
  options: AndroidAttestationOptions
): Collected => {
  const evidence: Evidence = {};
  if (request.chain.length < 2) return { failure: "chain_too_short", evidence };
  const chain = request.chain.map((pem) => parseCertificate(pemToDer(pem)));
  // 除叶子外再出现 attestation 扩展，就是在把别人的证明接到自己的密钥上。
  if (chain.slice(1).some((cert) => cert.extensions.has(ANDROID_KEY_DESCRIPTION_OID)))
    return { failure: "attestation_extension_after_leaf", evidence };
  const leaf = chain[0];
  // 叶子密钥必须就是注册上来的那把，否则「一条合法链」可以在设备之间任意转借。
  if (
    request.expectedPublicKey &&
    !bytesEqual(leaf.spki, Buffer.from(request.expectedPublicKey, "base64"))
  )
    return { failure: "leaf_key_mismatch", evidence };
  const extension = leaf.extensions.get(ANDROID_KEY_DESCRIPTION_OID);
  if (!extension) return { failure: "missing_key_description", evidence };
  const description = parseKeyDescription(extension.value);
  // 老 Keymaster 不走授权列表标签 709，`attestationApplicationId` 以独立扩展（1.16）出现；
  // 两处口径归一成同一个字段，后续包名/签名摘要校验不必再分叉。
  if (!description.applicationId) {
    const legacy = leaf.extensions.get(ANDROID_ATTESTATION_APPLICATION_ID_OID);
    if (legacy) description.applicationId = parseApplicationId(legacy.value);
  }
  evidence.description = description;
  if (!bytesEqual(description.attestationChallenge, Buffer.from(request.expectedChallenge)))
    return { failure: "challenge_mismatch", evidence };
  const hardware = buildChain(
    chain,
    parseRootPems(options.hardwareRoots ?? ANDROID_HARDWARE_ATTESTATION_ROOT_PEMS),
    "hardware"
  );
  const match =
    hardware.match ??
    buildChain(
      chain,
      parseRootPems(options.softwareRoots ?? ANDROID_SOFTWARE_ATTESTATION_ROOT_PEMS),
      "software"
    ).match;
  if (!match) {
    const reason =
      hardware.failure === "unsupported_algorithm"
        ? "unsupported_signature_algorithm"
        : "untrusted_root_or_bad_signature";
    return { failure: reason, evidence, detail: hardware.failure };
  }
  evidence.rootKind = match.kind;
  return {
    chain: { description, audited: [...match.path, match.anchor], rootKind: match.kind },
  };
};

/** 命中吊销是拒绝（回该条记录）；CRL 本身不可用/过期只留痕，判定照旧用已知数据做。 */
const applyRevocation = (
  audited: readonly AttestationCertificate[],
  snapshot: RevocationSnapshot,
  markers: string[]
): RevocationHit | null => {
  const hit = findRevocation(audited, snapshot);
  if (hit) {
    if (REVOKING_STATUSES.has(hit.status)) return hit;
    markers.push("certificate_status_abnormal");
  }
  if (snapshot.state !== "fresh") markers.push(`crl_${snapshot.state}`);
  return null;
};

/** 强度不足但完整性没问题的场合：全部只加标记。 */
const applyStrengthMarkers = (
  chain: VerifiedChain,
  request: AndroidAttestationRequest,
  markers: string[]
): void => {
  const now = request.now ?? Date.now();
  if (chain.audited.some((cert) => cert.notBefore > now || cert.notAfter < now))
    markers.push("certificate_expired");
  if (usesWeakHash(chain.audited)) markers.push("weak_signature_hash");
  if (chain.description.securityLevel === "software") markers.push("software_security_level");
};

const verifyRootOfTrust = (chain: VerifiedChain): string | null => {
  // 链锚到软件根却上报硬件强度：这是伪造硬件证明，直接拒。
  if (chain.rootKind === "software" && chain.description.securityLevel !== "software")
    return "security_level_root_mismatch";
  const trust = chain.description.rootOfTrust;
  if (!trust) return "missing_root_of_trust";
  if (!trust.deviceLocked) return "bootloader_unlocked";
  return trust.verifiedBootState === "verified" ? null : `boot_state_${trust.verifiedBootState}`;
};

const verifyApplicationId = (
  chain: VerifiedChain,
  request: AndroidAttestationRequest,
  markers: string[]
): string | null => {
  const applicationId = chain.description.applicationId;
  if (!applicationId) return "missing_attestation_application_id";
  if (!applicationId.packageNames.includes(request.expectedPackageName)) return "package_mismatch";
  const expected = request.expectedSignatureDigests ?? [];
  if (expected.length === 0) {
    // 不配签名摘要就只能证明「是这个包名的设备」，防不住重打包后自签同名 APK：封顶 degraded。
    markers.push("signature_digest_unverified");
    return null;
  }
  // 与 Google 参考实现同口径：期望的任一所签证书出现在证明里即算匹配（签名轮换期会同时列出多个）。
  const matched = expected.some((digest) =>
    applicationId.signatureDigests.some((actual) => bytesEqual(actual, base64ToBytes(digest)))
  );
  return matched ? null : "signature_digest_mismatch";
};

const buildVerdict = (
  level: ClientAttestationLevel,
  reasons: string[],
  evidence: Evidence
): AndroidAttestationVerdict => {
  const trust = evidence.description?.rootOfTrust;
  return {
    level,
    reasons,
    securityLevel: evidence.description?.securityLevel,
    verifiedBootState: trust?.verifiedBootState,
    deviceLocked: trust?.deviceLocked,
    rootKind: evidence.rootKind,
    attestedPackageName: evidence.description?.applicationId?.packageNames.join(","),
  };
};

/**
 * 入口：验证一条 Android Key Attestation 链并给出三档结论。
 * 不向调用方抛业务异常——所有不合规输入都归入 `rejected`，调用方只看 `level` 与 `reasons`；
 * 非 `DerError` 的意外异常照旧上抛，那是本模块的缺陷，不该被算成「客户端不可信」。
 */
export const verifyAndroidAttestation = async (
  request: AndroidAttestationRequest,
  options: AndroidAttestationOptions
): Promise<AndroidAttestationVerdict> => {
  const markers: string[] = [];
  const warn = options.onWarn;
  let collected: Collected;
  try {
    collected = collectEvidence(request, options);
  } catch (error) {
    if (!(error instanceof DerError)) throw error;
    warn?.("Android attestation 结构解析失败", error.message);
    return buildVerdict("rejected", ["malformed_attestation"], {});
  }
  if ("failure" in collected) {
    warn?.("Android attestation 判定拒绝", collected.detail ?? collected.failure);
    return buildVerdict("rejected", [collected.failure], collected.evidence);
  }
  const { chain } = collected;
  const revoked = applyRevocation(chain.audited, await options.revocation.snapshot(), markers);
  if (revoked) {
    warn?.("Android attestation 证书已被吊销", `serial=${revoked.serial} status=${revoked.status}`);
    return buildVerdict("rejected", ["certificate_revoked"], chain);
  }
  applyStrengthMarkers(collected.chain, request, markers);
  const bootReason = verifyRootOfTrust(collected.chain);
  if (bootReason) return rejectWith(warn, bootReason, collected.chain);
  const applicationReason = verifyApplicationId(collected.chain, request, markers);
  if (applicationReason) return rejectWith(warn, applicationReason, collected.chain);
  const level: ClientAttestationLevel = markers.length > 0 ? "degraded" : "trusted";
  if (level === "degraded") warn?.("Android attestation 以降级档放行", markers.join(","));
  return buildVerdict(level, markers, collected.chain);
};

const rejectWith = (
  warn: AndroidAttestationOptions["onWarn"],
  reason: string,
  evidence: Evidence
): AndroidAttestationVerdict => {
  warn?.("Android attestation 判定拒绝", reason);
  return buildVerdict("rejected", [reason], evidence);
};

/* ------------------------------------------------------------- 吊销列表缓存 */

export interface RevocationCacheOptions {
  fetcher?: (url: string, init?: RequestInit) => Promise<Response>;
  url?: string;
  /** 缓存有效期：过期后下一次判定触发回源，回源失败继续沿用旧快照。 */
  ttlMs?: number;
  timeoutMs?: number;
  /** Google 的状态列表是整表 JSON（实测 1 MB 量级），上限留足但不能无界。 */
  maxBytes?: number;
  now?: () => number;
  onWarn?: (message: string, detail?: string) => void;
}

const DEFAULT_TTL_MS = 6 * 60 * 60 * 1000;
const DEFAULT_TIMEOUT_MS = 10_000;
const DEFAULT_MAX_BYTES = 16 * 1024 * 1024;

/**
 * 解析状态列表。容器键两种写法都接：Google 参考实现读 `entries`，线上端点历史上带过 `status` 外层。
 * 结构不对就抛错，由缓存层沿用旧快照——绝不能把「解析不出来」当成「没有吊销」。
 */
export const parseRevocationStatus = (text: string): Map<string, string> => {
  const parsed: unknown = JSON.parse(text);
  if (!isRecord(parsed)) throw new Error("吊销列表顶层结构不正确");
  const container = isRecord(parsed.entries)
    ? parsed.entries
    : isRecord(parsed.status)
      ? parsed.status
      : undefined;
  if (!container) throw new Error("吊销列表缺少 entries/status 容器");
  const entries: [string, string][] = [];
  for (const [serial, raw] of Object.entries(container)) {
    const status = isRecord(raw) && typeof raw.status === "string" ? raw.status.toLowerCase() : "";
    if (!status || status === "ok") continue;
    entries.push([normalizeCrlKey(serial), status]);
  }
  // JSON 对象的整数形键（如 "33"）会被 JS 提前，与源码顺序无关；排序保证迭代确定性，
  // 方便日志与测试断言，不影响查找语义。
  return new Map(entries.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0)));
};

/** 带上限的流式读取：超限立即取消，避免上游异常把无界响应灌进内存。 */
const readCapped = async (response: Response, maxBytes: number): Promise<string> => {
  const body = response.body;
  if (!body) return "";
  const reader = body.getReader();
  const chunks: Buffer[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (!value) continue;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel().catch(() => {});
      throw new Error("吊销列表超出大小上限");
    }
    chunks.push(Buffer.from(value));
  }
  return Buffer.concat(chunks).toString("utf8");
};

export interface AndroidAttestationConfig {
  /** 期望包名；拿不到它就无从判断「是不是我们的 APK」，所以只有配了才装配校验器。 */
  packageName: string;
  /** APK 签名证书 DER 的摘要（base64/base64url，逗号分隔都可以，由调用方切好）。缺省只验包名。 */
  signatureDigests?: readonly string[];
  /** 信任根：缺省用内置的 Google 根，测试与私有 CA 可覆盖。 */
  hardwareRoots?: readonly string[];
  softwareRoots?: readonly string[];
  revocation?: RevocationSource;
  now?: () => number;
  onWarn?: (message: string, detail?: string) => void;
}

/** 设备注册链路注入的形态：一条链 + 一把待绑定的公钥进、一个结论出。 */
export type AndroidAttestationChecker = (
  input: ClientAttestationCheckInput
) => Promise<AndroidAttestationVerdict>;

/**
 * 按服务端配置装配校验器。根证书内置（新旧两把硬件根都要放，缺哪把都会成片误伤一类设备），
 * CRL 用带缓存的来源：拉不到时沿用上次结果并由 `verifyAndroidAttestation` 记降级留痕。
 */
export const createAndroidAttestationChecker = (
  config: AndroidAttestationConfig
): AndroidAttestationChecker => {
  const revocation =
    config.revocation ?? createRevocationCache({ now: config.now, onWarn: config.onWarn });
  return ({ chain, attestationChallenge, publicKey }) =>
    verifyAndroidAttestation(
      {
        chain,
        expectedChallenge: Buffer.from(attestationChallenge, "base64"),
        expectedPublicKey: publicKey,
        expectedPackageName: config.packageName,
        expectedSignatureDigests: config.signatureDigests,
        now: config.now?.(),
      },
      {
        revocation,
        hardwareRoots: config.hardwareRoots,
        softwareRoots: config.softwareRoots,
        onWarn: config.onWarn,
      }
    );
};

/**
 * 带缓存的 Google 吊销列表来源（P3.2 坑 2 的三条硬要求）：
 * - 拉取失败继续服务上一次成功缓存并记警告；
 * - 从不因拉不到而整片放行（`crl_unavailable` 降级留痕）或整片拒绝；
 * - 同一时刻只有一次在途请求：判定高峰既不打爆 Google 端点，也不会并发写缓存。
 */
export const createRevocationCache = (options: RevocationCacheOptions = {}): RevocationSource => {
  const fetcher = options.fetcher ?? fetch;
  const url = options.url ?? ANDROID_ATTESTATION_STATUS_URL;
  const ttlMs = options.ttlMs ?? DEFAULT_TTL_MS;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;
  const now = options.now ?? (() => Date.now());
  const onWarn = options.onWarn ?? (() => {});
  let cached: { entries: Map<string, string>; fetchedAt: number } | null = null;
  let pending: Promise<void> | null = null;

  const load = async (): Promise<void> => {
    try {
      const response = await fetcher(url, {
        signal: AbortSignal.timeout(timeoutMs),
        headers: { accept: "application/json" },
      });
      if (!response.ok) {
        await response.body?.cancel().catch(() => {});
        throw new Error(`HTTP ${response.status}`);
      }
      cached = {
        entries: parseRevocationStatus(await readCapped(response, maxBytes)),
        fetchedAt: now(),
      };
    } catch (error) {
      // 失败路径不动旧缓存：网络抖动时宁可拿着一份过期名单继续判吊销，也不清空证据。
      onWarn(
        "吊销列表刷新失败，沿用上一次结果",
        error instanceof Error ? error.message : String(error)
      );
    }
  };

  return {
    snapshot: async (): Promise<RevocationSnapshot> => {
      if (!cached || now() - cached.fetchedAt >= ttlMs) {
        pending ??= load().finally(() => {
          pending = null;
        });
        await pending;
      }
      if (!cached) return { entries: new Map(), fetchedAt: now(), state: "unavailable" };
      const fresh = now() - cached.fetchedAt < ttlMs;
      return {
        entries: cached.entries,
        fetchedAt: cached.fetchedAt,
        state: fresh ? "fresh" : "stale",
      };
    },
  };
};
