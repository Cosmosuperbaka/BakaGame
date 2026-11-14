import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useCEEStore } from "@/stores/UseCEEStore";
import type { CEECommandMap } from "@/lib/CEEWs";
import type { GameSendCommand } from "@/lib/GameWs";
import {
  CEE_NATIVE_ROOM_ID,
  ceeOriginalRoom,
  ceePrivateState,
  ceeSettledRoom,
  ceeSnapshot,
} from "@/stories/fixtures/CEE";
import { CEE_REPLAY_STORAGE_KEY } from "@/lib/CeeReplay";
import { stubMatchMedia } from "@/test/MatchMedia";
import CEERoomPage from "./CEERoomPage";

// 房间页的入房流程由 UseCEERoomLifecycle 的测试负责；这里只关心「在房间里」时页面对壳做了什么。
const lifecycle = vi.hoisted(() => ({ roomId: "1234", error: "" }));
vi.mock("@/hooks/UseCEERoomLifecycle", () => ({
  CEE_PASSWORD_ERROR_CODES: new Set<string>(),
  useCEERoomLifecycle: () => ({
    roomId: lifecycle.roomId,
    connected: true,
    joining: false,
    needsJoin: false,
    name: "",
    setName: vi.fn(),
    password: "",
    setPassword: vi.fn(),
    error: lifecycle.error,
    errorCode: "",
    join: vi.fn(),
    leave: vi.fn(),
  }),
}));
const gameArea = vi.hoisted(() => vi.fn<(props: { replayRounds?: unknown[] }) => void>());
vi.mock("@/components/cee/CEEGameArea", () => ({
  CEEGameArea: (props: { replayRounds?: unknown[] }) => {
    gameArea(props);
    return null;
  },
}));
vi.mock("@/components/cee/CEEPlayerList", () => ({ CEEPlayerList: () => null }));

const initial = useCEEStore.getState();
const setSecureScreen = vi.fn<(enabled: boolean) => void>();
const installShell = () => {
  window.__BAKA_CHANNEL__ = {
    clientType: "mobile",
    platform: "android",
    clientVersion: "1.0.0",
    setSecureScreen,
  };
};
const enterRoom = (antiCheat: boolean, roomId = CEE_NATIVE_ROOM_ID) => {
  lifecycle.roomId = roomId;
  useCEEStore.setState({
    connected: true,
    roomId,
    snapshot: ceeSnapshot({ roomId, bakaAntiCheat: antiCheat }),
    privateState: ceePrivateState(),
  });
};
const mount = () =>
  render(
    <MemoryRouter>
      <CEERoomPage />
    </MemoryRouter>
  );
/** 壳此刻的最终状态：最后一次调用的值（没调用过即未开启）。 */
const secureNow = () => setSecureScreen.mock.calls.at(-1)?.[0] ?? false;

beforeEach(() => {
  installShell();
});
afterEach(() => {
  useCEEStore.setState(initial, true);
  delete window.__BAKA_CHANNEL__;
  setSecureScreen.mockClear();
  gameArea.mockClear();
  window.localStorage.clear();
  lifecycle.roomId = "1234";
  lifecycle.error = "";
});

describe("CEE 房间页的窗口级防截屏", () => {
  it("进入反作弊房即开启，离开房间页恢复", () => {
    enterRoom(true);
    const view = mount();
    expect(secureNow()).toBe(true);
    view.unmount();
    expect(secureNow()).toBe(false);
  });

  it("普通房不开启", () => {
    enterRoom(false);
    mount();
    expect(setSecureScreen).not.toHaveBeenCalledWith(true);
  });

  it("从反作弊房换到普通房时关闭，换到另一间反作弊房时保持开启", async () => {
    enterRoom(true, "1234");
    mount();
    expect(secureNow()).toBe(true);
    await act(async () => enterRoom(true, "5678"));
    expect(secureNow()).toBe(true);
    await act(async () => enterRoom(false, "9012"));
    expect(secureNow()).toBe(false);
  });

  it("断线清空视图时关闭，重连回到反作弊房后重新开启", async () => {
    enterRoom(true);
    mount();
    expect(secureNow()).toBe(true);
    await act(async () => useCEEStore.setState({ snapshot: null, privateState: null }));
    expect(secureNow()).toBe(false);
    await act(async () => enterRoom(true));
    expect(secureNow()).toBe(true);
  });

  it("非壳环境静默跳过，不报错", () => {
    delete window.__BAKA_CHANNEL__;
    enterRoom(true);
    expect(() => mount().unmount()).not.toThrow();
    expect(setSecureScreen).not.toHaveBeenCalled();
  });
});

describe("CEE 房间页的猜测回放数据", () => {
  const settle = () => {
    const { snapshot, privateState } = ceeSettledRoom();
    useCEEStore.setState({ connected: true, roomId: snapshot.roomId, snapshot, privateState });
    lifecycle.roomId = snapshot.roomId;
  };
  const lastRounds = () => gameArea.mock.calls.at(-1)?.[0].replayRounds ?? [];

  it("回放功能关闭时不累积回合数据", () => {
    settle();
    mount();
    expect(lastRounds()).toEqual([]);
  });

  it("回放功能打开时累积已结算的回合", () => {
    window.localStorage.setItem(CEE_REPLAY_STORAGE_KEY, "1");
    settle();
    mount();
    expect(lastRounds()).toHaveLength(1);
  });
});

describe("CEE 房间页聊天入口的未读角标", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("窄屏聊天抽屉关着时别人发来的消息计入未读，打开抽屉清零", async () => {
    stubMatchMedia(false);
    enterRoom(false);
    mount();
    const toggle = screen.getByRole("button", { name: "聊天" });
    expect(toggle).not.toHaveAccessibleDescription();

    act(() =>
      useCEEStore.setState((state) => ({
        snapshot: {
          ...state.snapshot!,
          chat: [
            ...state.snapshot!.chat,
            {
              id: "c1",
              playerId: "someone-else",
              playerName: "别人",
              text: "来了",
              createdAt: Date.now(),
              system: false,
            },
          ],
        },
      }))
    );
    expect(toggle).toHaveAccessibleDescription("1 条未读");

    fireEvent.click(toggle);
    const dialog = await screen.findByRole("dialog", { name: "聊天" });
    fireEvent.keyDown(dialog, { key: "Escape" });
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    expect(screen.getByRole("button", { name: "聊天" })).not.toHaveAccessibleDescription();
  });
});

describe("CEE 房间页顶栏的设置面板", () => {
  const enterWithAgents = (allowAgents: boolean) => {
    lifecycle.roomId = CEE_NATIVE_ROOM_ID;
    const snapshot = ceeSnapshot({ roomId: CEE_NATIVE_ROOM_ID, bakaAntiCheat: false });
    useCEEStore.setState({
      connected: true,
      roomId: CEE_NATIVE_ROOM_ID,
      snapshot: { ...snapshot, settings: { ...snapshot.settings, allowAgents } },
      privateState: ceePrivateState(),
    });
  };
  const openSettings = async () => {
    mount();
    fireEvent.click(screen.getByRole("button", { name: "设置" }));
    return screen.findByRole("dialog");
  };

  it("房主没开 MCP 时，接管开关禁用并说明原因", async () => {
    enterWithAgents(false);
    const dialog = await openSettings();
    expect(within(dialog).getByRole("switch", { name: /交给 Agent 操作/ })).toBeDisabled();
    expect(dialog).toHaveTextContent("本房间未开启 MCP");
  });

  it("房主开了 MCP 时，同一个开关可用", async () => {
    enterWithAgents(true);
    const dialog = await openSettings();
    expect(within(dialog).getByRole("switch", { name: /交给 Agent 操作/ })).toBeEnabled();
    expect(dialog).not.toHaveTextContent("本房间未开启 MCP");
  });
});

describe("CEE 房间页的聊天与断线提示", () => {
  it("聊天栏发出的命令带上输入的原文，发出后输入框清空", async () => {
    const sendCommand = vi.fn().mockResolvedValue({});
    enterRoom(false);
    useCEEStore.setState({ sendCommand: sendCommand as unknown as GameSendCommand<CEECommandMap> });
    mount();

    const input = screen.getByRole("combobox", { name: "聊天消息" });
    expect(screen.getByRole("button", { name: "发送消息" })).toBeDisabled();

    fireEvent.change(input, { target: { value: "这波我猜到了" } });
    fireEvent.click(screen.getByRole("button", { name: "发送消息" }));
    await waitFor(() =>
      expect(sendCommand).toHaveBeenCalledWith("cee.chat.send", { text: "这波我猜到了" })
    );
    await waitFor(() => expect(input).toHaveValue(""));
  });

  it("聊天发送失败以错误提示报出", async () => {
    const sendCommand = vi.fn().mockRejectedValue({ code: "BAD", message: "发送太快了" });
    enterRoom(false);
    useCEEStore.setState({ sendCommand: sendCommand as unknown as GameSendCommand<CEECommandMap> });
    mount();

    fireEvent.change(screen.getByRole("combobox", { name: "聊天消息" }), {
      target: { value: "这波我猜到了" },
    });
    fireEvent.click(screen.getByRole("button", { name: "发送消息" }));
    await waitFor(() =>
      expect(useCEEStore.getState().toasts.at(-1)).toMatchObject({
        text: "发送太快了",
        type: "error",
      })
    );
  });

  it("加入失败（非密码步）以错误提示报出", () => {
    lifecycle.error = "房间已满";
    mount();
    expect(useCEEStore.getState().toasts.at(-1)).toMatchObject({ text: "房间已满", type: "error" });
  });

  it("原版房上游断线时顶栏报原版重连，上游恢复后收起", async () => {
    const { snapshot, privateState } = ceeOriginalRoom();
    lifecycle.roomId = snapshot.roomId;
    useCEEStore.setState({ connected: true, roomId: snapshot.roomId, snapshot, privateState });
    mount();

    // 同一份文案在宽窄两档各有一个播报节点。
    expect(screen.getAllByText("原版重连中...").length).toBeGreaterThan(0);
    await act(async () =>
      useCEEStore.setState({ snapshot: { ...snapshot, upstreamConnected: true } })
    );
    // 提示是带动效退场的，恢复后要等它退完。
    await waitFor(() => expect(screen.queryAllByText("原版重连中...")).toEqual([]));
  });
});
