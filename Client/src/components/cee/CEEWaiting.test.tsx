import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

import { createDefaultCEESettings } from "@bakagame/shared/values";
import { useCEEStore } from "@/stores/UseCEEStore";
import { ceeWsClient } from "@/lib/CEEWs";
import { ceePrivateState, ceeSnapshot } from "@/stories/fixtures/CEE";
import { CEEWaiting, restoreCEESettings } from "./CEEWaiting";

const initialStoreState = useCEEStore.getState();

describe("restoreCEESettings", () => {
  afterEach(() => {
    useCEEStore.setState(initialStoreState, true);
  });

  it("不使用目录时只发送玩法设置", async () => {
    const sendCommand = vi.fn().mockResolvedValue({});
    useCEEStore.setState({ sendCommand });
    const settings = createDefaultCEESettings(2020);

    await restoreCEESettings({ settings });

    expect(sendCommand).toHaveBeenCalledExactlyOnceWith("cee.room.settings", { settings });
  });

  it("MCP 开关沿用当前房间值，不被玩法记忆重置", async () => {
    const sendCommand = vi.fn().mockResolvedValue({});
    useCEEStore.setState({
      sendCommand,
      snapshot: { settings: { allowAgents: true } } as never,
    });
    const settings = createDefaultCEESettings(2020);

    await restoreCEESettings({ settings });

    expect(sendCommand).toHaveBeenCalledExactlyOnceWith("cee.room.settings", {
      settings: { ...settings, allowAgents: true },
    });
  });

  it("使用目录时先同步目录再保存设置", async () => {
    const sendCommand = vi.fn().mockResolvedValue({});
    useCEEStore.setState({ sendCommand });
    const settings = { ...createDefaultCEESettings(2020), useIndex: true, indexId: 42 };

    await restoreCEESettings({ settings });

    expect(sendCommand.mock.calls.map(([type]) => type)).toEqual([
      "cee.directory.import",
      "cee.room.settings",
    ]);
    expect(sendCommand).toHaveBeenCalledWith("cee.directory.import", { indexId: 42 });
    expect(sendCommand).toHaveBeenCalledWith("cee.room.settings", { settings });
  });

  it("目录同步失败时整体放弃，不再保存可能抽不出题的设置", async () => {
    const sendCommand = vi.fn().mockRejectedValue(new Error("目录同步失败"));
    useCEEStore.setState({ sendCommand });
    const settings = { ...createDefaultCEESettings(2020), useIndex: true, indexId: 42 };

    await expect(restoreCEESettings({ settings })).rejects.toThrow("目录同步失败");
    expect(sendCommand).toHaveBeenCalledTimes(1);
  });
});

describe("等待页的房间设置草稿", () => {
  const player = (id: string) => ({
    id,
    name: id,
    online: true,
    ready: false,
    team: null,
    membership: "active" as const,
    score: 0,
    status: "waiting" as const,
    attempts: 0,
    marks: "",
    syncCompleted: false,
  });
  const room = (name: string, hostPlayerId: string) => {
    const snapshot = ceeSnapshot({
      name,
      hostPlayerId,
      players: [player("old-host"), player("me")],
    });
    useCEEStore.setState({
      source: "native",
      roomId: snapshot.roomId,
      sessionToken: "t",
      snapshot,
    });
    return snapshot;
  };
  const me = ceePrivateState({ playerId: "me" });

  it("成为房主后显示服务端当前房名，保存不会把进房时的旧房名写回去", async () => {
    const user = userEvent.setup();
    const send = vi.spyOn(ceeWsClient, "send").mockResolvedValue({});
    const view = render(
      <CEEWaiting snapshot={room("进房时的房名", "old-host")} privateState={me} />
    );
    // 原房主改了房名，随后把房主移交给我。
    view.rerender(<CEEWaiting snapshot={room("改过的房名", "old-host")} privateState={me} />);
    view.rerender(<CEEWaiting snapshot={room("改过的房名", "me")} privateState={me} />);

    await user.click(screen.getByText("房间设置", { exact: true }));
    expect(screen.getByRole("textbox", { name: "房间名称" })).toHaveValue("改过的房名");
    await user.click(screen.getByRole("switch", { name: "允许旁观" }));
    await waitFor(() =>
      expect(send).toHaveBeenCalledWith(
        "cee.room.update",
        expect.objectContaining({ name: "改过的房名", allowSpectators: false }),
        expect.any(Object)
      )
    );
  });

  it("成为房主时不会立刻把服务端原值再写一遍", async () => {
    const send = vi.spyOn(ceeWsClient, "send").mockResolvedValue({});
    const view = render(
      <CEEWaiting snapshot={room("进房时的房名", "old-host")} privateState={me} />
    );
    view.rerender(<CEEWaiting snapshot={room("改过的房名", "me")} privateState={me} />);
    await new Promise((resolve) => setTimeout(resolve, 600));
    expect(send).not.toHaveBeenCalled();
  });

  it("防抖期间对局已开始或已换房，卸载冲刷不会发送房间设置", async () => {
    const send = vi.spyOn(ceeWsClient, "send").mockResolvedValue({});
    for (const leave of ["started", "switched"] as const) {
      const user = userEvent.setup();
      const view = render(<CEEWaiting snapshot={room("房名", "me")} privateState={me} />);
      await user.click(screen.getByText("房间设置", { exact: true }));
      await user.click(screen.getByRole("switch", { name: "允许旁观" }));
      if (leave === "started") {
        useCEEStore.setState({ snapshot: ceeSnapshot({ name: "房名", phase: "guessing" }) });
      } else {
        useCEEStore.setState({ snapshot: ceeSnapshot({ name: "房名", roomId: "5678" }) });
      }
      view.unmount();
    }
    await new Promise((resolve) => setTimeout(resolve, 600));
    expect(send).not.toHaveBeenCalled();
  });

  it("仍在同一房间的等待阶段时，卸载会冲刷房间设置", async () => {
    const send = vi.spyOn(ceeWsClient, "send").mockResolvedValue({});
    const user = userEvent.setup();
    const view = render(<CEEWaiting snapshot={room("房名", "me")} privateState={me} />);
    await user.click(screen.getByText("房间设置", { exact: true }));
    await user.click(screen.getByRole("switch", { name: "允许旁观" }));
    view.unmount();
    expect(send).toHaveBeenCalledWith(
      "cee.room.update",
      expect.objectContaining({ allowSpectators: false }),
      expect.any(Object)
    );
  });
});
