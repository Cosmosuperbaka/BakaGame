import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SiteAgent } from "./UseSiteAgents";
import {
  getSiteAgents,
  removeSiteAgent,
  resetSiteAgents,
  setSiteAgents,
  upsertSiteAgent,
  useSiteAgents,
} from "./UseSiteAgents";

const agent = (id: string, label = "浏览首页"): SiteAgent => ({
  id,
  agentName: `助手${id}`,
  tool: "probe",
  kind: "site",
  label,
  at: 1,
});

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  resetSiteAgents();
  vi.useRealTimers();
});

describe("首页 Agent 活动", () => {
  it("整份替换列表，同 id 上报覆盖旧条目而不追加", () => {
    const { result } = renderHook(() => useSiteAgents());
    expect(result.current).toEqual([]);

    act(() => setSiteAgents([agent("a"), agent("b")]));
    expect(result.current.map((entry) => entry.id)).toEqual(["a", "b"]);

    act(() => upsertSiteAgent(agent("a", "进入房间")));
    expect(result.current).toHaveLength(2);
    expect(result.current.at(-1)).toMatchObject({ id: "a", label: "进入房间" });
    expect(getSiteAgents()).toHaveLength(2);
  });

  it("移除不存在的 id 不改动列表，也不通知订阅者", () => {
    act(() => setSiteAgents([agent("a")]));
    const before = getSiteAgents();
    const { result } = renderHook(() => useSiteAgents());

    act(() => removeSiteAgent("missing"));
    expect(getSiteAgents()).toBe(before);

    act(() => removeSiteAgent("a"));
    expect(result.current).toEqual([]);
  });

  it("本地兜底计时到期收掉条目，续报会重新计时", async () => {
    const { result } = renderHook(() => useSiteAgents());
    act(() => setSiteAgents([agent("a")]));

    await act(() => vi.advanceTimersByTimeAsync(124_000));
    expect(result.current).toHaveLength(1);

    act(() => upsertSiteAgent(agent("a")));
    await act(() => vi.advanceTimersByTimeAsync(124_000));
    expect(result.current).toHaveLength(1);

    await act(() => vi.advanceTimersByTimeAsync(1_000));
    expect(result.current).toEqual([]);
  });

  it("整份替换与清空都收掉旧计时器，过期回调不再改动新列表", async () => {
    const { result } = renderHook(() => useSiteAgents());
    act(() => setSiteAgents([agent("a")]));
    act(() => setSiteAgents([agent("b")]));
    await act(() => vi.advanceTimersByTimeAsync(125_000));
    expect(result.current).toEqual([]);

    act(() => setSiteAgents([agent("c")]));
    act(() => resetSiteAgents());
    expect(result.current).toEqual([]);
    await act(() => vi.advanceTimersByTimeAsync(125_000));
    expect(result.current).toEqual([]);
  });
});
