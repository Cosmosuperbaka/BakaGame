import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";

/**
 * 原版题目的口令模式 AES：OpenSSL 兼容容器（`Salted__` + 8 字节盐 + AES-256-CBC/PKCS7，
 * 密钥与 IV 由 EVP_BytesToKey(MD5, 1 轮) 从口令与盐派生），base64 编码。
 * 上游用 crypto-js 的口令模式加密，这里用运行时原生实现与之字节级互通。
 */
const MAGIC = Buffer.from("Salted__");
const SALT_LENGTH = 8;
const KEY_LENGTH = 32;
const IV_LENGTH = 16;

function deriveKeyAndIv(secret: string, salt: Buffer): { key: Buffer; iv: Buffer } {
  const pass = Buffer.from(secret, "utf8");
  let block = Buffer.alloc(0);
  let material = Buffer.alloc(0);
  while (material.length < KEY_LENGTH + IV_LENGTH) {
    block = createHash("md5").update(block).update(pass).update(salt).digest();
    material = Buffer.concat([material, block]);
  }
  return {
    key: material.subarray(0, KEY_LENGTH),
    iv: material.subarray(KEY_LENGTH, KEY_LENGTH + IV_LENGTH),
  };
}

export function aesEncrypt(plain: string, secret: string): string {
  const salt = randomBytes(SALT_LENGTH);
  const { key, iv } = deriveKeyAndIv(secret, salt);
  const cipher = createCipheriv("aes-256-cbc", key, iv);
  return Buffer.concat([MAGIC, salt, cipher.update(plain, "utf8"), cipher.final()]).toString(
    "base64"
  );
}

/** 口令错误或容器格式不对一律抛错；调用方统一映射为兼容配置错误。 */
export function aesDecrypt(encoded: string, secret: string): string {
  const raw = Buffer.from(encoded, "base64");
  // 缺少 `Salted__` 头的输入不是这个容器，不能退化成空盐静默解密。
  if (raw.length < MAGIC.length + SALT_LENGTH || !raw.subarray(0, MAGIC.length).equals(MAGIC))
    throw new Error("不是口令模式 AES 容器");
  const salt = raw.subarray(MAGIC.length, MAGIC.length + SALT_LENGTH);
  const { key, iv } = deriveKeyAndIv(secret, salt);
  const decipher = createDecipheriv("aes-256-cbc", key, iv);
  return Buffer.concat([
    decipher.update(raw.subarray(MAGIC.length + SALT_LENGTH)),
    decipher.final(),
  ]).toString("utf8");
}
