import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { WhoIsFakerPrivateState, WhoIsFakerRoomSnapshot } from "@/types";
import { useWhoIsFakerStore } from "@/stores/UseWhoIsFakerStore";

import { WaitingPhase } from "./WaitingPhase";

const initialStoreState = useWhoIsFakerStore.getState();
const originalClipboardDescriptor = Object.getOwnPropertyDescriptor(navigator, "clipboard");

const snapshot: WhoIsFakerRoomSnapshot = {
  roomId: "1234",
  name: "房间",
  visibility: "public",
  allowSpectators: true,
  hasPassword: false,
  hostPlayerId: "host",
  testMode: false,
  roleLimits: {
    maxUndercoverCount: 1,
    canEnableAngel: false,
    canEnableBlank: false,
  },
  settings: {
    roleConfig: { undercoverCount: 1, hasAngel: false, hasBlank: false },
  },
  status: { phase: "waiting", started: false, day: 0 },
  players: [
    {
      id: "host",
      name: "房主",
      score: 0,
      membership: "active",
      online: true,
      isReady: true,
      isBot: false,
      isHost: true,
      roundStatus: "waiting",
    },
    {
      id: "guest",
      name: "玩家",
      score: 0,
      membership: "active",
      online: true,
      isReady: false,
      isBot: false,
      isHost: false,
      roundStatus: "waiting",
    },
  ],
  descriptions: [],
  chat: [],
};

const privateState: WhoIsFakerPrivateState = {
  playerId: "guest",
  sessionToken: "session",
  isQuestioner: false,
  canSubmitBlankGuess: false,
  blankGuessUsed: false,
  nightActionSubmitted: false,
};

describe("waiting room sharing", () => {
  beforeEach(() => {
    useWhoIsFakerStore.setState({ ...initialStoreState, snapshot, privateState }, true);
  });

  afterEach(() => {
    try {
      cleanup();
    } finally {
      useWhoIsFakerStore.setState(initialStoreState, true);
      if (originalClipboardDescriptor) {
        Object.defineProperty(navigator, "clipboard", originalClipboardDescriptor);
      } else {
        Reflect.deleteProperty(navigator, "clipboard");
      }
    }
    expect(Object.getOwnPropertyDescriptor(navigator, "clipboard")).toEqual(originalClipboardDescriptor);
    expect(useWhoIsFakerStore.getState()).toBe(initialStoreState);
    expect(useWhoIsFakerStore.getState().sendCommand).toBe(initialStoreState.sendCommand);
  });

  it("lets a non-host copy the room link", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText },
    });

    render(<WaitingPhase />);
    fireEvent.click(screen.getByRole("button", { name: "复制" }));

    await waitFor(() => {
      expect(writeText).toHaveBeenCalledWith(`${window.location.origin}/whoisfaker/room/1234`);
    });
    expect(screen.getByRole("button", { name: "已复制" })).toBeInTheDocument();
  });

  it("非房主在设置预览中默认展示死亡揭露身份胶囊", () => {
    render(<WaitingPhase />);
    expect(screen.getByText("死亡揭露身份")).toBeInTheDocument();
  });

  it("非房主在设置关闭揭露时展示死亡隐藏身份胶囊", () => {
    useWhoIsFakerStore.setState({
      snapshot: {
        ...snapshot,
        settings: {
          ...snapshot.settings,
          revealRoleOnDeath: false,
        },
      },
    });
    render(<WaitingPhase />);
    expect(screen.getByText("死亡隐藏身份")).toBeInTheDocument();
  });

  it("房主展开房间设置后可切换死亡时揭露身份开关", async () => {
    const sendCommand = vi.fn().mockResolvedValue({});
    useWhoIsFakerStore.setState({
      snapshot: {
        ...snapshot,
        players: snapshot.players.map((p) =>
          p.id === "host" ? { ...p, isHost: true } : { ...p, isHost: false },
        ),
      },
      privateState: {
        ...privateState,
        playerId: "host",
      },
      sendCommand,
    });

    render(<WaitingPhase />);
    // 房主展开房间设置
    fireEvent.click(screen.getByRole("button", { name: /房间设置/ }));

    // 找到死亡时揭露身份开关
    const toggle = screen.getByRole("switch", { name: "死亡时揭露身份" });
    expect(toggle).toBeInTheDocument();
    expect(toggle).toHaveAttribute("aria-checked", "true");

    // 点击切换为关闭
    fireEvent.click(toggle);
    expect(toggle).toHaveAttribute("aria-checked", "false");
  });

  it("房主设置字段由可见标签命名，密码占位文案随是否已有密码变化", () => {
    useWhoIsFakerStore.setState({
      privateState: { ...privateState, playerId: "host" },
      sendCommand: vi.fn().mockResolvedValue({}),
    });

    const { unmount } = render(<WaitingPhase />);
    fireEvent.click(screen.getByRole("button", { name: /房间设置/ }));

    expect(screen.getByRole("textbox", { name: "房间名称" })).toHaveValue("房间");
    // 只有两名参与者：卧底上限为 1，天使不可开启；上限与开启条件都挂在控件的说明上。
    const undercover = screen.getByRole("textbox", { name: "卧底人数" });
    expect(undercover).toHaveValue("1");
    expect(undercover).toHaveAccessibleDescription("上限 1");
    expect(screen.getByRole("button", { name: "增加卧底人数" })).toBeDisabled();
    const angel = screen.getByRole("switch", { name: "天使" });
    expect(angel).toBeDisabled();
    expect(angel).toHaveAccessibleDescription("8 人开启");

    // 还没有密码时留空不会保存，占位文案提示房主设置密码。
    fireEvent.click(screen.getByRole("switch", { name: "私密房间" }));
    expect(screen.getByLabelText("房间密码")).toHaveAttribute("placeholder", "设置房间密码");
    unmount();

    useWhoIsFakerStore.setState({ snapshot: { ...snapshot, visibility: "private", hasPassword: true } });
    render(<WaitingPhase />);
    fireEvent.click(screen.getByRole("button", { name: /房间设置/ }));
    expect(screen.getByLabelText("房间密码")).toHaveAttribute("placeholder", "留空则保留当前密码");
  });

  it("房主独自在房时开始按钮提示等待加入，不显示 0/0", () => {
    useWhoIsFakerStore.setState({
      snapshot: { ...snapshot, players: snapshot.players.filter((p) => p.id === "host") },
      privateState: { ...privateState, playerId: "host" },
    });
    render(<WaitingPhase />);
    expect(screen.getByRole("button", { name: "等待玩家加入" })).toBeDisabled();
  });

  it("准备命令等待应答期间按钮进入加载态，连点不会重复发送", async () => {
    let resolve: (value: Record<string, unknown>) => void = () => {};
    const sendCommand = vi.fn(() => new Promise<Record<string, unknown>>((r) => { resolve = r; }));
    useWhoIsFakerStore.setState({ sendCommand });
    render(<WaitingPhase />);

    fireEvent.click(screen.getByRole("button", { name: "准备" }));
    const pending = await screen.findByRole("button", { name: "正在准备..." });
    expect(pending).toBeDisabled();
    fireEvent.click(pending);
    expect(sendCommand).toHaveBeenCalledTimes(1);

    resolve({});
    expect(await screen.findByRole("button", { name: "准备" })).toBeEnabled();
  });
});
