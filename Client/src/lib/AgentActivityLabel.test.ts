import { describe, expect, it } from "vitest";
import { SITE_PAGE_ACTIONS } from "@bakagame/shared/values";
import { agentActivityLabel, agentActivityText } from "./AgentActivityLabel";

describe("Agent 活动标签", () => {
  it("共享契约里的每个页面动作都有标签，不会静默落成「正在思考」", () => {
    for (const action of SITE_PAGE_ACTIONS) {
      expect(agentActivityText(action, "目标")).not.toBe("正在思考");
      expect(agentActivityText(action, "目标")).toContain("目标");
    }
  });

  it("两步之间、或服务端发来未知动作时显示「正在思考」，不把原型链属性当标签", () => {
    expect(agentActivityText("click", "按钮", true)).toBe("正在思考");
    expect(agentActivityText("hover")).toBe("正在思考");
    expect(agentActivityText("constructor")).toBe("正在思考");
  });

  it("焦点类型：自报位置优先，未知类型回落到「正在操作」", () => {
    expect(agentActivityLabel("lobby")).toBe("正在查看大厅");
    expect(agentActivityLabel("lobby", "卧底大厅")).toBe("卧底大厅");
    expect(agentActivityLabel("brand-new-kind")).toBe("正在操作");
    expect(agentActivityLabel("toString")).toBe("正在操作");
  });
});
