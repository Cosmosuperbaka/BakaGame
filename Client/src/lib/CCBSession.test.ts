import { describe, expect, it } from "vitest";
import { ccbDisplayRound, readCCBSession, removeCCBSession, writeCCBSession } from "./CCBSession";

describe("CCB 会话凭据", () => {
  it("只按统一房号存取，不同房号互不影响", () => {
    writeCCBSession("1234", "first-token");
    writeCCBSession("5678", "second-token");
    expect(readCCBSession("1234")).toBe("first-token");
    expect(readCCBSession("5678")).toBe("second-token");
    expect(readCCBSession("9012")).toBeNull();
    removeCCBSession("1234");
    expect(readCCBSession("1234")).toBeNull();
    expect(readCCBSession("5678")).toBe("second-token");
  });
});

describe("CCB 顶栏局数", () => {
  it("准备与出题阶段显示即将开始的一局，其余阶段显示最近开始的一局", () => {
    expect(ccbDisplayRound("waiting", 0)).toBe(0);
    expect(ccbDisplayRound("preparing", 0)).toBe(1);
    expect(ccbDisplayRound("answering", 0)).toBe(1);
    expect(ccbDisplayRound("guessing", 1)).toBe(1);
    expect(ccbDisplayRound("settled", 1)).toBe(1);
    expect(ccbDisplayRound("waiting", 1)).toBe(1);
    expect(ccbDisplayRound("preparing", 1)).toBe(2);
  });
});
