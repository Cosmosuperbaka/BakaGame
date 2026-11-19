import { describe, expect, it } from "vitest";
import { errorCode, errorText, isAbortError } from "./ErrorMessage";

describe("errorText", () => {
  it("取协议拒绝与 Error 自带的 message", () => {
    expect(errorText(new Error("房间已关闭"), "兜底")).toBe("房间已关闭");
    expect(errorText({ code: "NOT_HOST", message: "只有房主可以操作" }, "兜底")).toBe(
      "只有房主可以操作"
    );
  });

  it("只有空白判定的兜底不改文案本身", () => {
    expect(errorText({ message: " 房间已关闭 " }, "兜底")).toBe(" 房间已关闭 ");
  });

  it("没有可用 message 时落到兜底，不出现 undefined", () => {
    for (const bad of [
      undefined,
      null,
      "字符串",
      42,
      {},
      { message: 7 },
      { message: "" },
      { message: "  " },
    ]) {
      expect(errorText(bad, "兜底")).toBe("兜底");
    }
  });
});

describe("errorCode", () => {
  it("取协议错误体的字符串 code", () => {
    expect(errorCode({ code: "NOT_HOST", message: "只有房主可以操作" })).toBe("NOT_HOST");
  });

  it("没有字符串 code 时回 undefined", () => {
    for (const bad of [undefined, null, "字符串", 42, {}, { code: 7 }, { code: null }]) {
      expect(errorCode(bad)).toBeUndefined();
    }
  });
});

describe("isAbortError", () => {
  it("认 DOMException 与同名错误对象的 AbortError", () => {
    expect(isAbortError(new DOMException("入房操作已取消", "AbortError"))).toBe(true);
    expect(isAbortError({ name: "AbortError" })).toBe(true);
  });

  it("其它错误与没有 name 的捕获值不算取消", () => {
    for (const other of [
      undefined,
      null,
      "AbortError",
      42,
      {},
      { name: "TypeError" },
      new Error("AbortError"),
    ]) {
      expect(isAbortError(other)).toBe(false);
    }
  });
});
