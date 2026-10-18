import { createCipheriv, createDecipheriv, hkdfSync, randomBytes } from "node:crypto";

const VERSION = "v1";
const IV_BYTES = 12;
const TAG_BYTES = 16;

/**
 * 云同步敏感设置（音乐平台 cookie）的落库加密：AES-256-GCM。
 *
 * 密钥由 `BETTER_AUTH_SECRET` 经 HKDF 派生，用途标签独立，轮换会话密钥即同时作废旧密文；
 * 附加数据绑定「用户 ID + 设置键」，密文被挪到别的行无法解开。
 */
export class SettingCipher {
  private readonly key: Buffer;

  constructor(secret: string) {
    this.key = Buffer.from(hkdfSync("sha256", secret, "bakagame", "user-setting-encryption", 32));
  }

  encrypt(plaintext: string, userId: string, settingKey: string): string {
    const iv = randomBytes(IV_BYTES);
    const cipher = createCipheriv("aes-256-gcm", this.key, iv);
    cipher.setAAD(Buffer.from(`${userId}\n${settingKey}`));
    const body = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
    return `${VERSION}.${Buffer.concat([iv, cipher.getAuthTag(), body]).toString("base64url")}`;
  }

  /** 密钥已轮换或数据被篡改时返回 `null`，调用方按「云端无数据」处理。 */
  decrypt(token: string, userId: string, settingKey: string): string | null {
    const [version, payload] = token.split(".");
    if (version !== VERSION || !payload) return null;
    const raw = Buffer.from(payload, "base64url");
    if (raw.length < IV_BYTES + TAG_BYTES) return null;
    try {
      const decipher = createDecipheriv("aes-256-gcm", this.key, raw.subarray(0, IV_BYTES));
      decipher.setAAD(Buffer.from(`${userId}\n${settingKey}`));
      decipher.setAuthTag(raw.subarray(IV_BYTES, IV_BYTES + TAG_BYTES));
      return Buffer.concat([
        decipher.update(raw.subarray(IV_BYTES + TAG_BYTES)),
        decipher.final(),
      ]).toString("utf8");
    } catch {
      return null;
    }
  }
}
