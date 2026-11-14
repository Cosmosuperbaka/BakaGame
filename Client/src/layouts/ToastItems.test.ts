import { describe, expect, it } from "vitest";
import { toToastItems } from "./ToastItems";

describe("单条提示转通知列表", () => {
  it("有提示时按语义与文字生成 id，没有提示时给空列表", () => {
    expect(toToastItems({ text: "密码错误", type: "error" })).toEqual([
      { id: "error:密码错误", text: "密码错误", type: "error" },
    ]);
    expect(toToastItems(null)).toEqual([]);
  });

  it("同一句话重复出现时 id 不变，换了文字才换 id", () => {
    const first = toToastItems({ text: "轮到你了", type: "info" })[0];
    const again = toToastItems({ text: "轮到你了", type: "info" })[0];
    const other = toToastItems({ text: "轮到你了", type: "error" })[0];
    expect(again.id).toBe(first.id);
    expect(other.id).not.toBe(first.id);
  });
});
