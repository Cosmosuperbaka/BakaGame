import { describe, expect, it } from "vitest";
import { readCCBSession, removeCCBSession, writeCCBSession } from "./CCBSession";

describe("CCB 双源会话", () => {
  it("同号房间的来源与上游配置分别隔离", () => {
    writeCCBSession("native", "native", "1234", "local-token");
    writeCCBSession("original", "server-a", "1234", "remote-token");
    expect(readCCBSession("native", "native", "1234")).toBe("local-token");
    expect(readCCBSession("original", "server-a", "1234")).toBe("remote-token");
    expect(readCCBSession("original", "server-b", "1234")).toBeNull();
    removeCCBSession("original", "server-a", "1234");
    expect(readCCBSession("original", "server-a", "1234")).toBeNull();
    expect(readCCBSession("native", "native", "1234")).toBe("local-token");
  });
});
