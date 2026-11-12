import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createDefaultCEESettings } from "@bakagame/shared/values";
import type { CEESettings } from "@bakagame/shared";
import { ceeWsClient } from "@/lib/CEEWs";
import { useCEEStore } from "@/stores/UseCEEStore";
import { CEE_NATIVE_ROOM_ID, ceeSnapshot } from "@/stories/fixtures/CEE";
import { CEEGameSettings } from "./CEEGameSettings";

const base = (changes: Partial<CEESettings> = {}): CEESettings => ({
  ...createDefaultCEESettings(2026),
  ...changes,
});
/** 把本机视作已在该房间里：保存边界读的是 Store 里的当前快照。 */
const inRoom = (
  settings: CEESettings,
  patch: { roomId?: string; phase?: "waiting" | "guessing" } = {}
) => {
  const roomId = patch.roomId ?? CEE_NATIVE_ROOM_ID;
  useCEEStore.setState({
    source: "native",
    roomId,
    sessionToken: "token",
    snapshot: ceeSnapshot({ roomId, settings, phase: patch.phase ?? "waiting" }),
  });
};
const panel = (settings: CEESettings, props: { waiting?: boolean; readOnly?: boolean } = {}) => (
  <CEEGameSettings
    roomId={CEE_NATIVE_ROOM_ID}
    settings={settings}
    source="native"
    waiting={props.waiting ?? true}
    readOnly={props.readOnly ?? false}
  />
);

afterEach(() => {
  useCEEStore.getState().resetRoom();
  vi.restoreAllMocks();
});

describe("CEE 设置草稿与服务端同步", () => {
  it("成为房主后面板显示服务端当前值，保存不会把挂载时的旧值写回去", async () => {
    const user = userEvent.setup();
    const send = vi.spyOn(ceeWsClient, "send").mockResolvedValue({});
    const mounted = base();
    // 我作为非房主进房时的设置；之后原房主改了「同步模式」再把房主移交给我。
    inRoom(mounted);
    const view = render(panel(mounted, { readOnly: true }));
    const current = base({ syncMode: true });
    inRoom(current);
    view.rerender(panel(current, { readOnly: true }));
    view.rerender(panel(current, { readOnly: false }));

    await user.click(screen.getByRole("button", { name: /猜测设置/ }));
    expect(screen.getByRole("switch", { name: "同步模式" })).toBeChecked();
    await user.click(screen.getByRole("switch", { name: "血战模式" }));
    await waitFor(() =>
      expect(send).toHaveBeenCalledWith(
        "cee.room.settings",
        { settings: expect.objectContaining({ syncMode: true, nonstopMode: true }) },
        expect.any(Object)
      )
    );
  });

  it("成为房主时不会立刻把服务端原值再写一遍", async () => {
    const send = vi.spyOn(ceeWsClient, "send").mockResolvedValue({});
    inRoom(base());
    const view = render(panel(base(), { readOnly: true }));
    const current = base({ maxAttempts: 7 });
    inRoom(current);
    view.rerender(panel(current, { readOnly: false }));
    await new Promise((resolve) => setTimeout(resolve, 600));
    expect(send).not.toHaveBeenCalled();
  });

  it("房主没有未保存修改时，服务端设置变化会同步进草稿", async () => {
    const user = userEvent.setup();
    inRoom(base());
    const view = render(panel(base()));
    const next = base({ nonstopMode: true });
    inRoom(next);
    view.rerender(panel(next));
    await user.click(screen.getByRole("button", { name: /猜测设置/ }));
    expect(screen.getByRole("switch", { name: "血战模式" })).toBeChecked();
  });

  it("房主有未保存修改时，服务端设置变化不会冲掉它", async () => {
    const user = userEvent.setup();
    const send = vi.spyOn(ceeWsClient, "send").mockResolvedValue({});
    inRoom(base());
    // waiting=false：改动只留在草稿里，不触发保存，便于观察草稿本身。
    const view = render(panel(base(), { waiting: false }));
    await user.click(screen.getByRole("button", { name: /猜测设置/ }));
    await user.click(screen.getByRole("switch", { name: "同步模式" }));
    const next = base({ nonstopMode: true });
    inRoom(next, { phase: "guessing" });
    view.rerender(panel(next, { waiting: false }));
    expect(screen.getByRole("switch", { name: "同步模式" })).toBeChecked();
    expect(screen.getByRole("switch", { name: "血战模式" })).not.toBeChecked();
    expect(send).not.toHaveBeenCalled();
  });

  it("成为房主后，目录已同步的判断跟随服务端当前设置，不挡住保存", async () => {
    const user = userEvent.setup();
    const send = vi.spyOn(ceeWsClient, "send").mockResolvedValue({});
    inRoom(base());
    const view = render(panel(base(), { readOnly: true }));
    const current = base({ useIndex: true, indexId: 42 });
    inRoom(current);
    view.rerender(panel(current, { readOnly: false }));
    await user.click(screen.getByRole("button", { name: /猜测设置/ }));
    await user.click(screen.getByRole("switch", { name: "同步模式" }));
    await waitFor(() =>
      expect(send).toHaveBeenCalledWith(
        "cee.room.settings",
        { settings: expect.objectContaining({ useIndex: true, indexId: 42, syncMode: true }) },
        expect.any(Object)
      )
    );
  });
});

describe("CEE 设置自动保存的发送边界", () => {
  /** 房主刚改完一项，还在防抖窗口里。 */
  const editedWhileWaiting = async () => {
    const user = userEvent.setup();
    inRoom(base());
    const view = render(panel(base()));
    await user.click(screen.getByRole("button", { name: /猜测设置/ }));
    await user.click(screen.getByRole("switch", { name: "同步模式" }));
    return view;
  };

  it("仍在同一房间的等待阶段时，卸载会冲刷未保存的修改", async () => {
    const send = vi.spyOn(ceeWsClient, "send").mockResolvedValue({});
    const view = await editedWhileWaiting();
    view.unmount();
    expect(send).toHaveBeenCalledWith(
      "cee.room.settings",
      { settings: expect.objectContaining({ syncMode: true }) },
      expect.any(Object)
    );
  });

  it("防抖期间对局已开始，卸载冲刷不会发送", async () => {
    const send = vi.spyOn(ceeWsClient, "send").mockResolvedValue({});
    const view = await editedWhileWaiting();
    inRoom(base(), { phase: "guessing" });
    view.unmount();
    expect(send).not.toHaveBeenCalled();
  });

  it("防抖期间已换到另一间房，排队中的保存不会发给新房间", async () => {
    const send = vi.spyOn(ceeWsClient, "send").mockResolvedValue({});
    const view = await editedWhileWaiting();
    inRoom(base(), { roomId: "5678" });
    view.unmount();
    await new Promise((resolve) => setTimeout(resolve, 600));
    expect(send).not.toHaveBeenCalled();
  });
});
