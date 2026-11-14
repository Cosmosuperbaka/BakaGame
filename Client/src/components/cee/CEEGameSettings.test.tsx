import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  CEE_SETTING_BOUNDS,
  SUBJECT_YEAR_BOUNDS,
  createDefaultCEESettings,
} from "@bakagame/shared/values";
import type { CEESettings } from "@bakagame/shared";
import { ceeWsClient } from "@/lib/CEEWs";
import { useCEEStore } from "@/stores/UseCEEStore";
import { CEE_NATIVE_ROOM_ID, ceeSnapshot } from "@/stories/fixtures/CEE";
import { CEEGameSettings } from "./CEEGameSettings";

const base = (changes: Partial<CEESettings> = {}): CEESettings => ({
  ...createDefaultCEESettings(2026),
  ...changes,
});
const CEE_MEMORY_KEY = "bakagame:room-settings:cee";
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
  vi.useRealTimers();
  useCEEStore.getState().resetRoom();
  vi.restoreAllMocks();
  window.localStorage.removeItem(CEE_MEMORY_KEY);
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

  it("成为房主时草稿与服务端现值相同：没有提交任何东西，也不往下次建房的记忆里写", async () => {
    vi.spyOn(ceeWsClient, "send").mockResolvedValue({});
    window.localStorage.removeItem(CEE_MEMORY_KEY);
    inRoom(base());
    const view = render(panel(base(), { readOnly: true }));
    const current = base({ maxAttempts: 7 });
    inRoom(current);
    view.rerender(panel(current, { readOnly: false }));
    await new Promise((resolve) => setTimeout(resolve, 600));
    expect(window.localStorage.getItem(CEE_MEMORY_KEY)).toBeNull();
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

describe("CEE 设置自动保存的防抖与失败", () => {
  /** 展开猜测设置并点一个开关，草稿进入防抖窗口。 */
  const edit = (label: string) => {
    fireEvent.click(screen.getByRole("button", { name: /猜测设置/ }));
    fireEvent.click(screen.getByRole("switch", { name: label }));
  };
  const advance = async (ms: number) => {
    await act(async () => {
      await vi.advanceTimersByTimeAsync(ms);
    });
  };

  it("房主改一项：防抖 400 毫秒到点才发保存", async () => {
    vi.useFakeTimers();
    const send = vi.spyOn(ceeWsClient, "send").mockResolvedValue({});
    inRoom(base());
    render(panel(base()));
    edit("同步模式");

    await advance(399);
    expect(send).not.toHaveBeenCalled();
    await advance(1);
    expect(send).toHaveBeenCalledTimes(1);
    expect(send).toHaveBeenCalledWith(
      "cee.room.settings",
      { settings: expect.objectContaining({ syncMode: true }) },
      expect.any(Object)
    );
  });

  it("房主连续改两项：防抖窗口内只发最后一次草稿", async () => {
    vi.useFakeTimers();
    const send = vi.spyOn(ceeWsClient, "send").mockResolvedValue({});
    inRoom(base());
    render(panel(base()));
    edit("同步模式");
    await advance(200);
    fireEvent.click(screen.getByRole("switch", { name: "血战模式" }));
    await advance(400);

    expect(send).toHaveBeenCalledTimes(1);
    expect(send).toHaveBeenCalledWith(
      "cee.room.settings",
      { settings: expect.objectContaining({ syncMode: true, nonstopMode: true }) },
      expect.any(Object)
    );
  });

  it("玩法设置保存被拒：把服务端给的原因交给全局提示", async () => {
    vi.useFakeTimers();
    vi.spyOn(ceeWsClient, "send").mockRejectedValue({ code: "BAD", message: "设置不合法" });
    inRoom(base());
    const showToast = vi.fn();
    useCEEStore.setState({ showToast });
    render(panel(base()));
    edit("同步模式");
    await advance(400);

    expect(showToast).toHaveBeenCalledWith("设置不合法", "error");
  });

  it("非房主只读：防抖到点也不发保存", async () => {
    vi.useFakeTimers();
    const send = vi.spyOn(ceeWsClient, "send").mockResolvedValue({});
    inRoom(base());
    render(panel(base(), { readOnly: true }));
    await advance(1_000);

    expect(send).not.toHaveBeenCalled();
  });

  it("玩法设置保存被拒：被拒的值不写进下次建房的记忆", async () => {
    vi.useFakeTimers();
    vi.spyOn(ceeWsClient, "send").mockRejectedValue({ code: "BAD", message: "设置不合法" });
    window.localStorage.removeItem(CEE_MEMORY_KEY);
    inRoom(base());
    render(panel(base()));
    edit("同步模式");
    await advance(400);

    expect(window.localStorage.getItem(CEE_MEMORY_KEY)).toBeNull();
  });

  it("记忆写在服务端接受之后：命令还在途时先不记，接受了才记", async () => {
    vi.useFakeTimers();
    let accept: (value: Record<string, unknown>) => void = () => {};
    vi.spyOn(ceeWsClient, "send").mockImplementation(
      () =>
        new Promise<Record<string, unknown>>((resolve) => {
          accept = resolve;
        })
    );
    window.localStorage.removeItem(CEE_MEMORY_KEY);
    inRoom(base());
    render(panel(base()));
    edit("同步模式");
    await advance(400);
    expect(window.localStorage.getItem(CEE_MEMORY_KEY)).toBeNull();

    accept({});
    await advance(0);
    expect(JSON.parse(window.localStorage.getItem(CEE_MEMORY_KEY)!)).toMatchObject({
      settings: { syncMode: true },
    });
  });

  it("记进下次建房的设置里 MCP 接入恒为关，不继承这间房的开关", async () => {
    vi.useFakeTimers();
    vi.spyOn(ceeWsClient, "send").mockResolvedValue({});
    window.localStorage.removeItem(CEE_MEMORY_KEY);
    inRoom(base({ allowAgents: true }));
    render(panel(base({ allowAgents: true })));
    edit("同步模式");
    await advance(400);
    await advance(0);

    expect(JSON.parse(window.localStorage.getItem(CEE_MEMORY_KEY)!)).toMatchObject({
      settings: { syncMode: true, allowAgents: false },
    });
  });
});

describe("CEE 设置字段的数值界限", () => {
  it("热度前几部、每部候选角色数与年份范围都取共享契约的界限", async () => {
    const user = userEvent.setup();
    inRoom(base());
    render(panel(base()));
    await user.click(screen.getByRole("button", { name: /题目设置/ }));

    const top = screen.getByRole("spinbutton", { name: "热度前几部" });
    expect(top).toHaveAttribute("aria-valuemin", String(CEE_SETTING_BOUNDS.topNSubjects.min));
    expect(top).toHaveAttribute("aria-valuemax", String(CEE_SETTING_BOUNDS.topNSubjects.max));
    const characters = screen.getByRole("spinbutton", { name: "每部候选角色数（人）" });
    expect(characters).toHaveAttribute(
      "aria-valuemin",
      String(CEE_SETTING_BOUNDS.characterNum.min)
    );
    expect(characters).toHaveAttribute(
      "aria-valuemax",
      String(CEE_SETTING_BOUNDS.characterNum.max)
    );
    for (const name of ["年份范围起始", "年份范围结束"]) {
      const year = screen.getByRole("spinbutton", { name });
      expect(year).toHaveAttribute("aria-valuemin", String(SUBJECT_YEAR_BOUNDS.min));
      expect(year).toHaveAttribute("aria-valuemax", String(SUBJECT_YEAR_BOUNDS.max));
    }
  });

  it("手输超出共享上限的值被夹回上限，与服务端接受的范围一致", async () => {
    const user = userEvent.setup();
    inRoom(base());
    render(panel(base()));
    await user.click(screen.getByRole("button", { name: /题目设置/ }));

    const top = screen.getByRole("spinbutton", { name: "热度前几部" });
    await user.clear(top);
    await user.type(top, "5000");
    await user.tab();
    expect(top).toHaveValue(String(CEE_SETTING_BOUNDS.topNSubjects.max));
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
