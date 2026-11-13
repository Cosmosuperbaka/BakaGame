import { describe, expect, it } from "vitest";
import { errorMessage } from "./SongErrorMessage";

describe("errorMessage", () => {
  it("取协议拒绝与 Error 自带的 message", () => {
    expect(errorMessage(new Error("房间已关闭"), "兜底")).toBe("房间已关闭");
    expect(errorMessage({ code: "NOT_HOST", message: "只有房主可以操作" }, "兜底")).toBe(
      "只有房主可以操作"
    );
  });

  it("没有可用 message 时落到兜底，不出现 undefined", () => {
    for (const bad of [undefined, null, "字符串", 42, {}, { message: 7 }, { message: "  " }]) {
      expect(errorMessage(bad, "兜底")).toBe("兜底");
    }
  });
});
