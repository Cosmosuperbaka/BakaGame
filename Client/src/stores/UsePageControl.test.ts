import { act, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import {
  clearAgentFocus,
  clearPageNotice,
  getAgentFocus,
  getPageControl,
  markAgentIdle,
  resetPageControl,
  setAgentFocus,
  setPageControl,
  showPageNotice,
  useAgentFocus,
  usePageControl,
  usePageNotice,
} from "./UsePageControl";

afterEach(() => {
  resetPageControl();
  clearAgentFocus();
  clearPageNotice();
});

describe("标签页接管状态", () => {
  it("默认未开启，写入后 hook 跟着变，收回后回到未开启", () => {
    const { result } = renderHook(() => usePageControl());
    expect(result.current).toEqual({ status: "off" });

    act(() => setPageControl({ status: "open", code: "123456", expiresAt: 10 }));
    expect(result.current).toEqual({ status: "open", code: "123456", expiresAt: 10 });
    expect(getPageControl().status).toBe("open");

    act(() => resetPageControl());
    expect(result.current).toEqual({ status: "off" });
  });

  it("整份替换而不是合并：新状态没写的字段不留在旧值上", () => {
    act(() => setPageControl({ status: "controlled", agentName: "甲" }));
    act(() => setPageControl({ status: "controlled", reconnecting: true }));
    expect(getPageControl()).toEqual({ status: "controlled", reconnecting: true });
  });
});

describe("Agent 焦点", () => {
  it("每次动作递增 seq，连点同一个控件也递增", () => {
    const { result } = renderHook(() => useAgentFocus());
    expect(result.current).toBeNull();

    act(() => setAgentFocus({ action: "click", label: "开始" }));
    const first = result.current;
    expect(first?.seq).toBe(1);

    act(() => setAgentFocus({ action: "click", label: "开始" }));
    expect(result.current?.seq).toBe(2);
    expect(getAgentFocus()?.label).toBe("开始");
  });

  it("标记空闲保留 seq 与目标，清空后回到 null", () => {
    const { result } = renderHook(() => useAgentFocus());
    act(() => setAgentFocus({ action: "click", controlId: "a" }));
    act(() => markAgentIdle());
    expect(result.current).toMatchObject({ seq: 1, controlId: "a", idle: true });

    act(() => clearAgentFocus());
    expect(result.current).toBeNull();
    // 没有焦点时标记空闲不该造出一个焦点。
    act(() => markAgentIdle());
    expect(result.current).toBeNull();
  });
});

describe("接管结束留言", () => {
  it("同一句话再留一次也递增 seq，清空后回到 null", () => {
    const { result } = renderHook(() => usePageNotice());
    expect(result.current).toBeNull();

    act(() => showPageNotice("接管已结束"));
    expect(result.current).toEqual({ text: "接管已结束", seq: 1 });
    act(() => showPageNotice("接管已结束"));
    expect(result.current).toEqual({ text: "接管已结束", seq: 2 });

    act(() => clearPageNotice());
    expect(result.current).toBeNull();
  });
});
