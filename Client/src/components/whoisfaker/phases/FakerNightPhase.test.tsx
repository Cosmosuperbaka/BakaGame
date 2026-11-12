import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { WhoIsFakerPrivateState, WhoIsFakerRoomSnapshot } from "@bakagame/shared";
import { useWhoIsFakerStore } from "@/stores/UseWhoIsFakerStore";
import { FakerNightPhase } from "./FakerNightPhase";

const player = (id: string, name: string, roundStatus: "alive" | "dead" = "alive") => ({
  id,
  name,
  score: 0,
  membership: "active" as const,
  online: true,
  isReady: true,
  isBot: false,
  isHost: id === "host_1",
  roundStatus,
});

const snapshot: WhoIsFakerRoomSnapshot = {
  roomId: "1234",
  name: "测试房间",
  visibility: "public",
  allowSpectators: true,
  hasPassword: false,
  hostPlayerId: "host_1",
  testMode: false,
  roleLimits: { maxUndercoverCount: 1, canEnableAngel: false, canEnableBlank: false },
  settings: { roleConfig: { undercoverCount: 1, hasAngel: false, hasBlank: false } },
  status: { phase: "night", started: true, day: 1, questionerPlayerId: "host_1" },
  players: [
    player("host_1", "出题人"),
    player("player_2", "玩家2"),
    player("player_3", "玩家3"),
    player("player_4", "玩家4"),
  ],
  descriptions: [],
  chat: [],
};

const baseState: WhoIsFakerPrivateState = {
  playerId: "player_2",
  sessionToken: "session_token",
  isQuestioner: false,
  canSubmitBlankGuess: false,
  blankGuessUsed: false,
  nightActionSubmitted: false,
};

const setup = (
  privateState: Partial<WhoIsFakerPrivateState>,
  room: WhoIsFakerRoomSnapshot = snapshot
) => {
  const sendCommand = vi.fn().mockResolvedValue({});
  useWhoIsFakerStore.setState({
    snapshot: room,
    privateState: { ...baseState, ...privateState },
    sendCommand,
  });
  render(<FakerNightPhase />);
  return sendCommand;
};

describe("FakerNightPhase", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("有夜间资格的存活玩家可选目标并提交夜晚行动", async () => {
    const sendCommand = setup({ canActAtNight: true });

    fireEvent.click(screen.getByRole("button", { name: /玩家3/ }));

    await waitFor(() => {
      expect(sendCommand).toHaveBeenCalledWith("game.submitNightAction", {
        targetId: "player_3",
      });
    });
    // 自己永远不是夜晚目标。
    expect(screen.queryByRole("button", { name: /玩家2/ })).toBeNull();
  });

  it("可以选择本夜不行动", async () => {
    const sendCommand = setup({ canActAtNight: true });

    fireEvent.click(screen.getByRole("button", { name: /不行动/ }));

    await waitFor(() => {
      expect(sendCommand).toHaveBeenCalledWith("game.submitNightAction", { targetId: null });
    });
  });

  it("已提交后显示回执并允许撤销，不再展示目标", async () => {
    const sendCommand = setup({
      canActAtNight: true,
      nightActionSubmitted: true,
      myCurrentNightTargetId: "player_3",
    });

    expect(screen.getByText("已完成夜晚决策")).toBeTruthy();
    expect(screen.queryByRole("button", { name: /玩家4/ })).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: /撤销/ }));
    await waitFor(() => {
      expect(sendCommand).toHaveBeenCalledWith("game.cancelNightAction");
    });
  });

  it.each(["angel", "blank"] as const)("%s 夜里没有行动，只看到等待说明", (specialRole) => {
    setup({ canActAtNight: false, specialRole });

    expect(screen.getByText("你今晚没有行动，等待天亮")).toBeTruthy();
    expect(screen.queryByRole("button", { name: /玩家3/ })).toBeNull();
    expect(screen.queryByRole("button", { name: /不行动/ })).toBeNull();
  });

  it("出局玩家看到等待天亮，没有行动控件", () => {
    const dead: WhoIsFakerRoomSnapshot = {
      ...snapshot,
      players: snapshot.players.map((item) =>
        item.id === "player_2" ? { ...item, roundStatus: "dead" } : item
      ),
    };
    setup({ canActAtNight: false }, dead);

    expect(screen.getByText("你已出局，等待天亮")).toBeTruthy();
    expect(screen.queryByRole("button", { name: /不行动/ })).toBeNull();
  });

  it("私有状态没有能力位时按没有资格处理", () => {
    setup({});

    expect(screen.queryByRole("button", { name: /不行动/ })).toBeNull();
  });
});
