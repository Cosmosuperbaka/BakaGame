import { createHash, createPublicKey, randomBytes, verify } from "node:crypto";
import { AppError } from "../domain/Errors";
import type { ClientChannelProof } from "../shared/Model";
import type { AndroidAttestationChecker } from "./AndroidAttestation";

/**
 * 客户端通道证明：壳（桌面 / 移动）用设备私钥签服务端发的挑战，服务端验签后发一次性 ticket，
 * ws 握手凭票写入 `ConnectionRecord.clientChannel`。
 * 协议逐字定义在 `Agents/ClientChannel.md`，改这里必须同步改那份文档。
 */
export const CLIENT_CHALLENGE_TTL_MS = 60_000;
export const CLIENT_TICKET_TTL_MS = 30_000;
/** 挑战与票都是短时内存态，必须有基数上限：伪造 clientId 不该让服务端按需扩张内存。 */
export const CLIENT_CHANNEL_PENDING_MAX = 10_000;

export type ClientKeyAlgorithm = "ed25519" | "ec-p256";
export type ClientAttestationLevel = "trusted" | "degraded" | "rejected";

/** 移动端注册时附带的一次性平台证明（桌面端没有平台级证明，不带该字段）。 */
export interface ClientAttestationReport {
  /** PEM 数组，叶子在前；Keystore 原样给出的链含根，接受裁掉根的写法。 */
  chain: string[];
  /** 设备生成密钥时喂给 `setAttestationChallenge` 的原始字节（base64）。 */
  attestationChallenge: string;
}

/** 校验器输入：额外带上本次注册的公钥，链必须能对得上它。 */
export interface ClientAttestationCheckInput extends ClientAttestationReport {
  publicKey: string;
}

export interface ClientSelfCheckReport {
  hardFail: string[];
  softFail: string[];
  keyProtection?: "hardware" | "software";
  attestationLevel?: ClientAttestationLevel;
}

export interface ClientRegisterInput {
  clientId?: string;
  clientType: ClientChannelProof["clientType"];
  platform: string;
  clientVersion: string;
  keyAlgorithm: ClientKeyAlgorithm;
  publicKey: string;
  selfCheck: ClientSelfCheckReport;
  attestation?: ClientAttestationReport;
}

export interface ClientAttestInput {
  clientId: string;
  challenge: string;
  signature: string;
  clientType: ClientChannelProof["clientType"];
  clientVersion: string;
  selfCheck: ClientSelfCheckReport;
}

export interface StoredClientDevice {
  clientId: string;
  clientType: ClientChannelProof["clientType"];
  platform: string;
  keyAlgorithm: ClientKeyAlgorithm;
  publicKey: string;
  keyProtection: "hardware" | "software";
  /** 服务端在注册时验出来的平台证明档位；缺省 = 没有平台证明（桌面端、未带链的移动端）。 */
  attestationLevel?: ClientAttestationLevel;
  registeredAt: number;
  lastSeenAt: number;
}

/** 只暴露三个动作：设备表在 MySQL，测试与本地用内存实现，判定逻辑不关心差异。 */
export interface ClientChannelStore {
  save(device: StoredClientDevice): Promise<void>;
  find(clientId: string): Promise<StoredClientDevice | undefined>;
  touch(clientId: string, at: number): Promise<void>;
}

export class InMemoryClientChannelStore implements ClientChannelStore {
  private readonly devices = new Map<string, StoredClientDevice>();
  async save(device: StoredClientDevice): Promise<void> {
    this.devices.set(device.clientId, device);
  }
  async find(clientId: string): Promise<StoredClientDevice | undefined> {
    return this.devices.get(clientId);
  }
  async touch(clientId: string, at: number): Promise<void> {
    const found = this.devices.get(clientId);
    if (found) this.devices.set(clientId, { ...found, lastSeenAt: at });
  }
}

/**
 * 硬失败：完整性已被破坏，或有证据表明检测本身被动过手脚（检测跑不动 = 有人让它在跑不动）。
 * 软失败：可疑但不构成结论（父进程异常、devtools 打开、未知无障碍服务、分身工作资料）。
 * `mark`：既不是作弊证据也不能当成「检测跑过且干净」，放行但标 `suspect`。
 * `keyProtection = "software"`（DPAPI 不可用）不在这里，它是环境探测、不进清单。
 *
 * 词表必须两边都收：移动端报的 id 在服务端查不到就会撞上面那条失败关闭，
 * 结果是**每一个开了读屏或分身的正常安卓用户都被拒进反作弊房**。
 * 移动端不少 id 带 `:<细节>` 后缀（命中的包名、su 的路径），判定只认冒号前的稳定前缀，
 * 后缀原样留在 reason 里供日志与人工复核。
 */
type SelfCheckWeight = "hard" | "soft" | "mark";

const SELF_CHECK_WEIGHTS: Record<string, SelfCheckWeight> = {
  // —— 桌面：Desktop/src-tauri/src/selfcheck.rs ——
  debugger_attached: "hard",
  debug_port: "hard",
  debug_object_handle: "hard",
  debug_query_unavailable: "hard",
  module_not_allowed: "hard",
  module_enumeration_failed: "hard",
  ldr_list_mismatch: "hard",
  ldr_enumeration_failed: "hard",
  parent_process: "soft",
  devtools: "soft",
  platform_unsupported: "mark",
  // —— 移动：Mobile/android/app/src/main/java/website/baka/game/channel/SelfCheck.kt ——
  accessibility_automation: "hard",
  root_su: "hard",
  root_test_keys: "hard",
  root_debuggable: "hard",
  root_magisk: "hard",
  root_magisk_mount: "hard",
  emulator_build: "hard",
  emulator_qemu: "hard",
  emulator_no_accelerometer: "hard",
  clone_source_path: "hard",
  clone_user_data: "hard",
  keystore_unavailable: "hard",
  accessibility_unknown: "soft",
  accessibility_check_failed: "soft",
  emulator_no_gyroscope: "soft",
  abi_x86: "soft",
  media_projection_active: "soft",
  media_projection_allowed: "soft",
  clone_user_id: "soft",
  clone_data_dir: "soft",
};

function weightOf(id: string): SelfCheckWeight | undefined {
  const colon = id.indexOf(":");
  return SELF_CHECK_WEIGHTS[colon === -1 ? id : id.slice(0, colon)];
}

export function judgeSelfCheck(report: ClientSelfCheckReport): {
  trusted: boolean;
  integrity: "clean" | "suspect";
  reason?: string;
} {
  const reported = [...report.hardFail, ...report.softFail];
  const known = reported.filter((id) => weightOf(id) !== undefined);
  // 按权重判，不按壳把它放进哪一格判：壳把硬失败塞进 softFail 一样是拒。
  const hard = known.filter((id) => weightOf(id) === "hard");
  if (hard.length > 0) return { trusted: false, integrity: "clean", reason: hard[0] };
  // 未登记的 id 不能当软失败放过：词表新增一项而服务端没跟上时，失败关闭比沉默放行安全。
  const unknown = reported.filter((id) => weightOf(id) === undefined);
  if (unknown.length > 0) return { trusted: false, integrity: "clean", reason: unknown[0] };
  if (report.attestationLevel === "rejected")
    return { trusted: false, integrity: "clean", reason: "attestation_rejected" };
  const soft = known.filter((id) => weightOf(id) === "soft");
  if (soft.length >= 2) return { trusted: false, integrity: "clean", reason: soft[1] };
  const marked = known.some((id) => weightOf(id) === "mark");
  return { trusted: true, integrity: soft.length === 1 || marked ? "suspect" : "clean" };
}

/** 版本号比较：`a < b` 为负、相等为 0、`a > b` 为正；缺省段按 0 补齐。 */
export function compareClientVersion(a: string, b: string): number {
  const left = a.split(".").map((part) => Number.parseInt(part, 10) || 0);
  const right = b.split(".").map((part) => Number.parseInt(part, 10) || 0);
  for (let i = 0; i < Math.max(left.length, right.length); i++) {
    const diff = (left[i] ?? 0) - (right[i] ?? 0);
    if (diff !== 0) return diff < 0 ? -1 : 1;
  }
  return 0;
}

const SPKI_ED25519_PREFIX = Buffer.from("302a300506032b6570032100", "hex");

function publicKeyOf(device: StoredClientDevice) {
  const raw = Buffer.from(device.publicKey, "base64");
  if (device.keyAlgorithm === "ed25519") {
    if (raw.length !== 32) throw new AppError("CLIENT_UNTRUSTED", "设备公钥长度不正确");
    return createPublicKey({
      key: Buffer.concat([SPKI_ED25519_PREFIX, raw]),
      format: "der",
      type: "spki",
    });
  }
  return createPublicKey({ key: raw, format: "der", type: "spki" });
}

/** 桌面签 Ed25519 裸签名，移动签 DER(ECDSA-P256-SHA256)；两者都对挑战原样字节签名。 */
export function verifyClientSignature(
  device: StoredClientDevice,
  challenge: string,
  signature: string
): boolean {
  const payload = Buffer.from(challenge, "ascii");
  const signatureBytes = Buffer.from(signature, "base64");
  try {
    if (device.keyAlgorithm === "ed25519") {
      if (signatureBytes.length !== 64) return false;
      return verify(null, payload, publicKeyOf(device), signatureBytes);
    }
    return verify("sha256", payload, publicKeyOf(device), signatureBytes);
  } catch {
    return false;
  }
}

/** `clientId` 由公钥派生：同一把密钥重复注册得到同一个身份，不需要额外的「证明我拥有它」往返。 */
export function clientIdOfPublicKey(publicKey: string): string {
  return `ccd_${createHash("sha256").update(publicKey).digest("hex").slice(0, 24)}`;
}

function bounded<T>(map: Map<string, T>, cap: number): void {
  while (map.size >= cap) {
    const oldest = map.keys().next().value;
    if (oldest === undefined) break;
    map.delete(oldest);
  }
}

export interface ClientChannelOptions {
  store: ClientChannelStore;
  now?: () => number;
  /** 最低支持版本按平台给：协议破坏性变更时抬这一档就能强制旧壳升级。 */
  minimumVersion: (clientType: ClientChannelProof["clientType"]) => string;
  onWarn?: (message: string, context?: Record<string, unknown>) => void;
  /**
   * Android Key Attestation 校验器。未注入时带链注册只记 `degraded`：
   * 服务端没配期望包名不该把真实设备挡在门外，但也不能当作「验过了」。
   */
  attestation?: AndroidAttestationChecker;
}

export class ClientChannel {
  private readonly store: ClientChannelStore;
  private readonly now: () => number;
  private readonly minimumVersion: ClientChannelOptions["minimumVersion"];
  private readonly onWarn: (message: string, context?: Record<string, unknown>) => void;
  private readonly attestation: AndroidAttestationChecker | undefined;
  private readonly challenges = new Map<string, { clientId: string; expiresAt: number }>();
  private readonly tickets = new Map<
    string,
    { proof: ClientChannelProof; clientIp: string; expiresAt: number }
  >();
  constructor(options: ClientChannelOptions) {
    this.store = options.store;
    this.now = options.now ?? (() => Date.now());
    this.minimumVersion = options.minimumVersion;
    this.onWarn = options.onWarn ?? (() => {});
    this.attestation = options.attestation;
  }
  isOutdated(clientType: ClientChannelProof["clientType"], clientVersion: string): boolean {
    const minimum = this.minimumVersion(clientType);
    return minimum.length > 0 && compareClientVersion(clientVersion, minimum) < 0;
  }
  private requireTrusted(
    selfCheck: ClientSelfCheckReport,
    stage: "register" | "attest",
    attestationLevel?: ClientAttestationLevel
  ): "clean" | "suspect" {
    // 服务端验出来的档位覆盖壳自报的：自报只可能对自己不利，改一句代码就能声明 trusted。
    const verdict = judgeSelfCheck(
      attestationLevel === undefined ? selfCheck : { ...selfCheck, attestationLevel }
    );
    if (!verdict.trusted) {
      this.onWarn("客户端完整性校验未通过", { stage, reason: verdict.reason });
      throw new AppError("CLIENT_UNTRUSTED", "客户端完整性校验未通过");
    }
    return verdict.integrity;
  }
  /**
   * 移动端注册时做一次完整证书链验证，结论随设备存下来；之后的握手只复用密钥签挑战。
   * 拒绝即拒：解锁刷机、改包、被吊销都是设备完整性被破坏，不是「证明强度不够」。
   * 没配校验器时只记 `degraded` 并留警告——链没被任何人看过，不该写成「验过但降级」。
   */
  private async resolveAttestationLevel(
    input: ClientRegisterInput
  ): Promise<ClientAttestationLevel | undefined> {
    if (input.clientType !== "mobile") return undefined;
    const report = input.attestation;
    if (!report || report.chain.length === 0) return undefined;
    if (!this.attestation) {
      this.onWarn("收到 Android 证明链但服务端未配置校验", { platform: input.platform });
      return "degraded";
    }
    const verdict = await this.attestation({ ...report, publicKey: input.publicKey });
    if (verdict.reasons.length > 0)
      this.onWarn("Android 证明链判定", { level: verdict.level, reasons: verdict.reasons });
    if (verdict.level === "rejected")
      throw new AppError("ATTESTATION_REJECTED", "设备平台证明未通过");
    return verdict.level;
  }
  async register(input: ClientRegisterInput): Promise<{
    clientId: string;
    minimumVersion: string;
    outdated: boolean;
  }> {
    const integrity = this.requireTrusted(input.selfCheck, "register");
    if (integrity === "suspect")
      this.onWarn("客户端以可疑状态注册", {
        clientType: input.clientType,
        platform: input.platform,
        softFail: input.selfCheck.softFail,
      });
    const attestationLevel = await this.resolveAttestationLevel(input);
    const clientId = clientIdOfPublicKey(input.publicKey);
    const at = this.now();
    await this.store.save({
      clientId,
      clientType: input.clientType,
      platform: input.platform,
      keyAlgorithm: input.keyAlgorithm,
      publicKey: input.publicKey,
      // DPAPI 不可用时私钥只有软件保护：放行并如实标记，不假装它是硬件密钥。
      keyProtection: input.selfCheck.keyProtection ?? "software",
      attestationLevel,
      registeredAt: at,
      lastSeenAt: at,
    });
    return {
      clientId,
      minimumVersion: this.minimumVersion(input.clientType),
      outdated: this.isOutdated(input.clientType, input.clientVersion),
    };
  }
  issue(clientId: string): { challenge: string; expiresAt: number } {
    const issuedAt = this.now();
    const challenge = `${clientId}.${randomBytes(24).toString("base64url")}.${issuedAt}`;
    bounded(this.challenges, CLIENT_CHANNEL_PENDING_MAX);
    this.challenges.set(challenge, { clientId, expiresAt: issuedAt + CLIENT_CHALLENGE_TTL_MS });
    return { challenge, expiresAt: issuedAt + CLIENT_CHALLENGE_TTL_MS };
  }
  async attest(
    input: ClientAttestInput,
    clientIp: string
  ): Promise<{
    ticket: string;
    expiresAt: number;
    outdated: boolean;
  }> {
    const pending = this.challenges.get(input.challenge);
    // 单次消费：验完即焚，否则一个被抓到的挑战可以在窗口内被反复换成票。
    this.challenges.delete(input.challenge);
    const at = this.now();
    if (!pending || pending.expiresAt < at || pending.clientId !== input.clientId)
      throw new AppError("CHALLENGE_EXPIRED", "校验挑战已过期，请重试");
    const device = await this.store.find(input.clientId);
    if (!device) throw new AppError("CLIENT_UNKNOWN", "该客户端尚未注册");
    if (!verifyClientSignature(device, input.challenge, input.signature))
      throw new AppError("CLIENT_UNTRUSTED", "客户端签名校验失败");
    const integrity = this.requireTrusted(input.selfCheck, "attest", device.attestationLevel);
    if (device.clientType !== input.clientType)
      throw new AppError("CLIENT_UNTRUSTED", "客户端类型与注册记录不符");
    const ticket = randomBytes(24).toString("base64url");
    bounded(this.tickets, CLIENT_CHANNEL_PENDING_MAX);
    this.tickets.set(ticket, {
      proof: {
        clientId: device.clientId,
        clientType: device.clientType,
        clientVersion: input.clientVersion,
        keyProtection: device.keyProtection,
        integrity,
        outdated: this.isOutdated(device.clientType, input.clientVersion),
      },
      clientIp,
      expiresAt: at + CLIENT_TICKET_TTL_MS,
    });
    await this.store.touch(device.clientId, at);
    return {
      ticket,
      expiresAt: at + CLIENT_TICKET_TTL_MS,
      outdated: this.isOutdated(device.clientType, input.clientVersion),
    };
  }
  /** 握手换票：一次性、绑定来源地址。地址不符只是不认，不把票销毁。 */
  consume(ticket: string | undefined, clientIp: string): ClientChannelProof | undefined {
    if (!ticket) return undefined;
    const held = this.tickets.get(ticket);
    if (!held) return undefined;
    if (held.expiresAt < this.now()) {
      this.tickets.delete(ticket);
      return undefined;
    }
    // 销毁会让合法客户端永远换不到票：代理链与 requestIP 口径不一致时，第一次握手失败是常态而非攻击。
    if (held.clientIp !== clientIp) return undefined;
    this.tickets.delete(ticket);
    return held.proof;
  }
  reset(): void {
    this.challenges.clear();
    this.tickets.clear();
  }
}
