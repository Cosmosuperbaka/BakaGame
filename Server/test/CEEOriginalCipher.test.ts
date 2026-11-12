import { describe, expect, test } from "bun:test";
import { aesDecrypt, aesEncrypt } from "../src/infrastructure/CEEOriginalCipher";

/** 由上游使用的口令模式 AES 库生成的固定密文：新实现必须逐字节解得同一明文。 */
const UPSTREAM_VECTORS = [
  {
    secret: "s3cret",
    plain: '{"id":1,"name":"测试角色😀"}',
    cipher:
      "U2FsdGVkX19bPNeWHcj1Vj6wCpkfQY9NUMvtihrS+YjsCktIg3pd3N/ggrVJahUMe5lSLf3pNIwGHVCDElJmuQ==",
  },
  {
    secret: "含中文密钥✓",
    plain: "x",
    cipher: "U2FsdGVkX18GPHH7G0HGtlDVHA5XJ3cpqUyaZibWReo=",
  },
  {
    secret: "a".repeat(200),
    plain: "中".repeat(40),
    cipher:
      "U2FsdGVkX1/dY9wDBUEePOcWoI9r9CyXVUGdDYS/7bh20y/i1p6uyDj0xmq0jwulL73bnUdDiCYTs5kRwCovuV0FXBw1pA4/ve2nb7nYccpinQ5JSP7jLU4RmCcc3Ldo02xletqVwjLEks/CxAC+++bQrKpDnakHqCFej1BMVq9puw0hGXXpwBB7xLEioSL/",
  },
];

describe("原版口令模式 AES", () => {
  test.each(UPSTREAM_VECTORS)("解开上游库生成的固定密文（口令 $secret）", (vector) => {
    expect(aesDecrypt(vector.cipher, vector.secret)).toBe(vector.plain);
  });

  test("加密结果是带 Salted__ 头的容器，每次盐不同，自身可往返", () => {
    const first = aesEncrypt("题目", "key");
    const second = aesEncrypt("题目", "key");
    expect(first).not.toBe(second);
    expect(Buffer.from(first, "base64").subarray(0, 8).toString()).toBe("Salted__");
    expect(aesDecrypt(first, "key")).toBe("题目");
    expect(aesDecrypt(second, "key")).toBe("题目");
  });

  test("长明文与多字节字符往返一致", () => {
    const plain = "中😀".repeat(5000);
    expect(aesDecrypt(aesEncrypt(plain, "含中文密钥✓"), "含中文密钥✓")).toBe(plain);
  });

  test("口令错误不会解出原文", () => {
    const encrypted = aesEncrypt('{"id":1}', "right");
    let leaked = 0;
    for (let index = 0; index < 200; index++) {
      try {
        if (aesDecrypt(encrypted, `wrong${index}`) === '{"id":1}') leaked++;
      } catch {
        // 填充校验失败即抛错，同样不会泄露原文。
      }
    }
    expect(leaked).toBe(0);
  });

  test("缺少 Salted__ 头或过短的输入直接拒绝", () => {
    expect(() => aesDecrypt(Buffer.from("not a container at all").toString("base64"), "k")).toThrow(
      "不是口令模式 AES 容器"
    );
    expect(() => aesDecrypt("", "k")).toThrow("不是口令模式 AES 容器");
  });
});
