import { describe, expect, it } from "vitest";
import { readCCBSession, removeCCBSession, writeCCBSession } from "./CCBSession";

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
