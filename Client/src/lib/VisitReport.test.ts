import { beforeEach, describe, expect, it, vi } from "vitest";

import type { ApiClient } from "./Api";
import { reportVisit, visitorId, visitSection } from "./VisitReport";

beforeEach(() => {
  window.localStorage.clear();
});

describe("访问上报", () => {
  it("访客 ID 首次生成后持久复用，且符合接口格式", () => {
    const first = visitorId();
    expect(first).toMatch(/^[A-Za-z0-9_-]{16,64}$/);
    expect(visitorId()).toBe(first);
  });

  it("按板块折叠路径，房号不单独计数", () => {
    expect(visitSection("/")).toBe("/");
    expect(visitSection("/whoisfaker")).toBe("/whoisfaker");
    expect(visitSection("/whoisfaker/room/ABC123")).toBe("/whoisfaker/room");
    expect(visitSection("/songuessr/solo")).toBe("/songuessr/solo");
    expect(visitSection("/admin/users")).toBe("/admin");
  });

  it("接口失败静默忽略", async () => {
    const visit = vi.fn(async () => {
      throw new Error("ACCOUNT_DISABLED");
    });
    expect(() => reportVisit("/cee", { site: { visit } } as unknown as ApiClient)).not.toThrow();
    await Promise.resolve();
    expect(visit).toHaveBeenCalledWith({ visitorId: visitorId(), path: "/cee" });
  });
});
