import { describe, expect, test } from "bun:test";

import { RoomPasswordGate } from "../../src/application/room/RoomPasswordGate";
import {
  JOIN_PASSWORD_MAX_ATTEMPTS,
  JOIN_PASSWORD_ROOM_MAX_ATTEMPTS,
  JOIN_PASSWORD_WINDOW_MS,
} from "../../src/config/Constants";
import { normalizeWord } from "../../src/domain/Rules";
import { expectAppError, expectAppErrorAsync } from "./RoomKernelFixtures";

/** 可数的假哈希：摘要就是 `h:` 前缀加明文，校验次数记下来。 */
const countingHasher = () => {
  const calls = { verify: 0 };
  return {
    calls,
    hash: async (password: string) => `h:${password}`,
    verify: async (password: string, digest: string) => {
      calls.verify += 1;
      return digest === `h:${password}`;
    },
  };
};

const createGate = (clock: { now: number }, hasher = countingHasher()) =>
  new RoomPasswordGate({
    now: () => clock.now,
    normalize: (value) => value.trim(),
    missingOnCreate: { code: "PASSWORD_REQUIRED", message: "私密房间需要密码" },
    missingOnJoin: { code: "PASSWORD_REQUIRED", message: "该房间需要密码" },
    hasher,
  });

const privateRoom = { id: "1234", passwordHash: "h:secret" };

describe("私密房口令门", () => {
  test("公开房直通：不要口令、不计数、也不比对摘要", async () => {
    const hasher = countingHasher();
    const gate = createGate({ now: 0 }, hasher);
    for (let index = 0; index < JOIN_PASSWORD_ROOM_MAX_ATTEMPTS + 1; index += 1) {
      await gate.verify(privateRoom, "public", undefined, `c${index}`);
    }
    expect(hasher.calls.verify).toBe(0);
  });

  test("缺口令回缺口令错误且不计数：之后正确口令照常通过", async () => {
    const gate = createGate({ now: 0 });
    for (let index = 0; index < JOIN_PASSWORD_MAX_ATTEMPTS * 2; index += 1) {
      await expectAppErrorAsync(
        () => gate.verify(privateRoom, "private", "   ", "c1"),
        "PASSWORD_REQUIRED"
      );
    }
    await gate.verify(privateRoom, "private", " secret ", "c1");
  });

  test("错到上限后正确口令也被拒、别的连接不受影响、窗口过后恢复", async () => {
    const clock = { now: 1_000 };
    const gate = createGate(clock);
    for (let index = 0; index < JOIN_PASSWORD_MAX_ATTEMPTS; index += 1) {
      await expectAppErrorAsync(
        () => gate.verify(privateRoom, "private", "wrong", "c1"),
        "PASSWORD_INCORRECT"
      );
    }
    await expectAppErrorAsync(
      () => gate.verify(privateRoom, "private", "secret", "c1"),
      "TOO_MANY_ATTEMPTS"
    );
    await gate.verify(privateRoom, "private", "secret", "c2");
    clock.now += JOIN_PASSWORD_WINDOW_MS + 1;
    await gate.verify(privateRoom, "private", "secret", "c1");
  });

  test("房间聚合额度：多开连接各试一次，合计到上限后新连接的正确口令也被拒", async () => {
    const gate = createGate({ now: 0 });
    for (let index = 0; index < JOIN_PASSWORD_ROOM_MAX_ATTEMPTS; index += 1) {
      await expectAppErrorAsync(
        () => gate.verify(privateRoom, "private", "wrong", `c${index}`),
        "PASSWORD_INCORRECT"
      );
    }
    await expectAppErrorAsync(
      () => gate.verify(privateRoom, "private", "secret", "fresh"),
      "TOO_MANY_ATTEMPTS"
    );
    await gate.verify({ id: "5678", passwordHash: "h:secret" }, "private", "secret", "fresh");
  });

  test("先计数后校验：猜中的那一次同样占额度", async () => {
    const gate = createGate({ now: 0 });
    for (let index = 0; index < JOIN_PASSWORD_MAX_ATTEMPTS; index += 1) {
      await gate.verify(privateRoom, "private", "secret", "c1");
    }
    await expectAppErrorAsync(
      () => gate.verify(privateRoom, "private", "secret", "c1"),
      "TOO_MANY_ATTEMPTS"
    );
  });

  test("以可见性而不是摘要是否存在为准：私密房摘要为空一律不匹配", async () => {
    const hasher = countingHasher();
    const gate = createGate({ now: 0 }, hasher);
    await expectAppErrorAsync(
      () => gate.verify({ id: "1234" }, "private", "anything", "c1"),
      "PASSWORD_INCORRECT"
    );
    await expectAppErrorAsync(
      () => gate.verify({ id: "1234", passwordHash: "" }, "private", "anything", "c1"),
      "PASSWORD_INCORRECT"
    );
    expect(hasher.calls.verify).toBe(0);
  });

  test("建房要求口令：规范化后为空抛缺口令错误", () => {
    const gate = createGate({ now: 0 });
    expectAppError(() => gate.require(undefined), "PASSWORD_REQUIRED");
    expectAppError(() => gate.require(null), "PASSWORD_REQUIRED");
    expectAppError(() => gate.require("  "), "PASSWORD_REQUIRED");
    expect(gate.require(" pw ")).toBe("pw");
  });

  test("缺省用慢哈希：摘要不含明文，规范化口径一致时建房与入房对得上", async () => {
    const gate = new RoomPasswordGate({
      now: () => 0,
      normalize: normalizeWord,
      missingOnCreate: { code: "PASSWORD_REQUIRED", message: "该操作需要有效密码" },
      missingOnJoin: { code: "PASSWORD_REQUIRED", message: "该操作需要有效密码" },
    });
    const digest = await gate.hash(gate.require("  open   sesame "));
    expect(digest).not.toContain("sesame");
    const room = { id: "1234", passwordHash: digest };
    await gate.verify(room, "private", "open sesame", "c1");
    await expectAppErrorAsync(
      () => gate.verify(room, "private", "open sesame!", "c1"),
      "PASSWORD_INCORRECT"
    );
  });
});
