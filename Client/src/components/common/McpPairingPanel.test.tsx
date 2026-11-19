import { act, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getPageControl, resetPageControl, setPageControl } from "@/stores/UsePageControl";
import { recordClockSample, resetClockSample } from "@/stores/UseServerClock";
import { McpPairingPanel } from "./McpPairingPanel";

describe("McpPairingPanel 配对码过期", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000_000);
    resetPageControl();
  });

  afterEach(() => {
    resetPageControl();
    resetClockSample();
    vi.useRealTimers();
  });

  it("本机时钟快 60 秒：配对码按服务端时刻过期，不会一生成就被收掉", () => {
    // 本机此刻 1_000_000，服务端此刻 940_000；码在服务端时刻 1_000_000 过期，还剩 60 秒。
    recordClockSample(940_000, 1_000_000, 1_000_000);
    setPageControl({ status: "open", code: "K7P2-9QXM", expiresAt: 1_000_000 });
    render(<McpPairingPanel />);

    act(() => {
      vi.advanceTimersByTime(59_000);
    });
    expect(getPageControl().status).toBe("open");

    act(() => {
      vi.advanceTimersByTime(2_000);
    });
    expect(getPageControl().status).toBe("off");
  });

  it("本机时钟慢 60 秒：已到服务端过期时刻的码立即收掉", () => {
    recordClockSample(1_060_000, 1_000_000, 1_000_000);
    setPageControl({ status: "open", code: "K7P2-9QXM", expiresAt: 1_030_000 });
    render(<McpPairingPanel />);

    act(() => {
      vi.advanceTimersByTime(1);
    });
    expect(getPageControl().status).toBe("off");
  });
});
