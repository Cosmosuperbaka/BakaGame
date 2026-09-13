import { render, screen, waitFor, act } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { mockCommitHistory } = vi.hoisted(() => ({
  mockCommitHistory: {
    currentCommit: "commit-v1",
  },
}));

vi.mock("virtual:commit-history", () => ({
  default: mockCommitHistory,
}));

import { VersionUpdateNotice } from "./VersionUpdateNotice";

describe("VersionUpdateNotice", () => {
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    mockCommitHistory.currentCommit = "commit-v1";
    // 默认按生产构建环境跑，开发环境单独用用例覆盖。
    vi.stubEnv("DEV", false);
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  it("does not check or display when running in dev environment", async () => {
    vi.stubEnv("DEV", true);
    const fetchSpy = vi.fn();
    globalThis.fetch = fetchSpy;

    render(<VersionUpdateNotice active={true} />);

    expect(fetchSpy).not.toHaveBeenCalled();
    expect(screen.queryByRole("status")).not.toBeInTheDocument();
  });

  it("does not check or display when current commit is dev", async () => {
    mockCommitHistory.currentCommit = "dev";
    const fetchSpy = vi.fn();
    globalThis.fetch = fetchSpy;

    render(<VersionUpdateNotice active={true} />);

    expect(fetchSpy).not.toHaveBeenCalled();
    expect(screen.queryByRole("status")).not.toBeInTheDocument();
  });

  it("does not check or display when active is false", async () => {
    const fetchSpy = vi.fn();
    globalThis.fetch = fetchSpy;

    render(<VersionUpdateNotice active={false} />);

    expect(fetchSpy).not.toHaveBeenCalled();
    expect(screen.queryByRole("status")).not.toBeInTheDocument();
  });

  it("does not display notice when deployed build matches current commit", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      text: async () =>
        '<!doctype html><html><head><meta name="bakagame-build" content="commit-v1"></head></html>',
    } as Response);

    render(<VersionUpdateNotice />);

    await waitFor(() => {
      expect(globalThis.fetch).toHaveBeenCalled();
    });

    expect(screen.queryByRole("status")).not.toBeInTheDocument();
  });

  it("displays notice with status role, message and refresh button when a newer build is deployed", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      text: async () =>
        '<!doctype html><html><head><meta name="bakagame-build" content="commit-v2"></head></html>',
    } as Response);

    const onReload = vi.fn();
    const user = userEvent.setup();

    render(<VersionUpdateNotice onReload={onReload} />);

    const notice = await screen.findByRole("status");
    expect(notice).toHaveTextContent("游戏有新版本，请刷新后继续游玩");

    const refreshButton = screen.getByRole("button", { name: /刷新/ });
    expect(refreshButton).toBeInTheDocument();

    await user.click(refreshButton);
    expect(onReload).toHaveBeenCalledTimes(1);
  });

  it("handles fetch failure or non-ok response gracefully without false alarms", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 502,
      text: async () => "Bad Gateway",
    } as Response);

    render(<VersionUpdateNotice />);

    await waitFor(() => {
      expect(globalThis.fetch).toHaveBeenCalled();
    });

    expect(screen.queryByRole("status")).not.toBeInTheDocument();
  });

  it("triggers check on window focus and visibilitychange", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      text: async () =>
        '<!doctype html><html><head><meta name="bakagame-build" content="commit-v1"></head></html>',
    } as Response);
    globalThis.fetch = fetchMock;

    render(<VersionUpdateNotice />);

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    // 模拟回到前台
    act(() => {
      window.dispatchEvent(new Event("focus"));
    });

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledTimes(2);
    });

    // 模拟 visibilitychange 为 visible
    Object.defineProperty(document, "visibilityState", {
      configurable: true,
      value: "visible",
    });

    act(() => {
      document.dispatchEvent(new Event("visibilitychange"));
    });

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledTimes(3);
    });
  });

  it("cleans up timer and listeners on unmount", async () => {
    const clearIntervalSpy = vi.spyOn(window, "clearInterval");
    const removeWindowListenerSpy = vi.spyOn(window, "removeEventListener");
    const removeDocListenerSpy = vi.spyOn(document, "removeEventListener");

    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      text: async () =>
        '<!doctype html><html><head><meta name="bakagame-build" content="commit-v1"></head></html>',
    } as Response);

    const { unmount } = render(<VersionUpdateNotice />);

    unmount();

    expect(clearIntervalSpy).toHaveBeenCalled();
    expect(removeWindowListenerSpy).toHaveBeenCalledWith("focus", expect.any(Function));
    expect(removeDocListenerSpy).toHaveBeenCalledWith(
      "visibilitychange",
      expect.any(Function),
    );
  });
});
