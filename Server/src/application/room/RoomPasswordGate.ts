import {
  JOIN_PASSWORD_MAX_ATTEMPTS,
  JOIN_PASSWORD_ROOM_MAX_ATTEMPTS,
  JOIN_PASSWORD_WINDOW_MS,
} from "../../config/Constants";
import type { RoomVisibility } from "../../shared/Model";
import { AppError } from "../../domain/Errors";
import { SlidingWindowRateLimiter } from "../../infrastructure/RateLimiter";

export interface PasswordGateError {
  code: string;
  message: string;
}

const TOO_MANY_ATTEMPTS: PasswordGateError = {
  code: "TOO_MANY_ATTEMPTS",
  message: "密码错误次数过多，请稍后再试",
};
const PASSWORD_INCORRECT: PasswordGateError = {
  code: "PASSWORD_INCORRECT",
  message: "房间密码错误",
};

export interface RoomPasswordGateOptions {
  now: () => number;
  /**
   * 口令规范化：摘要绑定规范化后的值，建房、改设置与入房必须同一口径。
   * TODO(行为统一)：卧底用 `normalizeWord`（去控制字符、折叠空白），猜歌与 CEE 只 `trim`。
   * 两种口径算出的摘要互不相认，接入时各传现值以免已有私密房进不去；统一后删掉本参数。
   */
  normalize: (password: string) => string;
  /** 建房与改设置时缺口令的错误。TODO(行为统一)：三款文案不同，统一后改成固定值。 */
  missingOnCreate: PasswordGateError;
  /**
   * 入房时缺口令的错误（不计数）。
   * TODO(行为统一)：卧底与 CEE 回 `PASSWORD_REQUIRED`，猜歌回 `PASSWORD_INCORRECT`；统一后改成固定值。
   */
  missingOnJoin: PasswordGateError;
  /** 测试注入：缺省用运行时的慢哈希。 */
  hasher?: {
    hash(password: string): Promise<string>;
    verify(password: string, digest: string): Promise<boolean>;
  };
}

const BUN_PASSWORD = {
  hash: (password: string) => Bun.password.hash(password),
  verify: (password: string, digest: string) => Bun.password.verify(password, digest),
};

/**
 * 私密房口令：规范化、摘要与入房校验。
 *
 * 入房校验的顺序是防护本身：以可见性（而不是「摘要存在与否」）决定要不要口令，
 * 摘要为空的私密房一律不匹配；缺口令不计数；先按「连接 + 房间」与「房间」两层计数、
 * 再比对摘要，超限后正确口令同样被拒，攻击者分不出猜中与猜错。
 */
export class RoomPasswordGate {
  /** 同一连接对同一房间的尝试额度。 */
  private readonly perConnection = new SlidingWindowRateLimiter({
    windowMs: JOIN_PASSWORD_WINDOW_MS,
    maxRequests: JOIN_PASSWORD_MAX_ATTEMPTS,
  });
  /** 同一房间所有连接合计的额度：只按连接计数时，多开连接就多倍爆破速度。 */
  private readonly perRoom = new SlidingWindowRateLimiter({
    windowMs: JOIN_PASSWORD_WINDOW_MS,
    maxRequests: JOIN_PASSWORD_ROOM_MAX_ATTEMPTS,
  });
  private readonly hasher: NonNullable<RoomPasswordGateOptions["hasher"]>;

  constructor(private readonly options: RoomPasswordGateOptions) {
    this.hasher = options.hasher ?? BUN_PASSWORD;
  }

  /** 建房与改设置：规范化；空值抛缺口令错误。返回值只用来算摘要，不得写进房间记录。 */
  require(password: string | null | undefined): string {
    const normalized = this.options.normalize(password ?? "");
    if (!normalized) throw this.error(this.options.missingOnCreate);
    return normalized;
  }

  hash(password: string): Promise<string> {
    return this.hasher.hash(password);
  }

  /** 入房校验；公开房直接通过。 */
  async verify(
    room: { id: string; passwordHash?: string },
    visibility: RoomVisibility,
    password: string | null | undefined,
    connectionId: string
  ): Promise<void> {
    if (visibility !== "private") return;
    const normalized = this.options.normalize(password ?? "");
    if (!normalized) throw this.error(this.options.missingOnJoin);
    const now = this.options.now();
    if (!this.perConnection.allow(`${connectionId}:${room.id}`, now))
      throw this.error(TOO_MANY_ATTEMPTS);
    if (!this.perRoom.allow(room.id, now)) throw this.error(TOO_MANY_ATTEMPTS);
    // 建房占号期间与改设置途中都可能出现「私密但还没有摘要」：此时一律不匹配，而不是放行。
    const digest = room.passwordHash;
    const matched = digest ? await this.hasher.verify(normalized, digest) : false;
    if (!matched) throw this.error(PASSWORD_INCORRECT);
  }

  private error(error: PasswordGateError): AppError {
    return new AppError(error.code, error.message);
  }
}
