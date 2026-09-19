import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import type { SonGuessrPlayerView } from "@/types";
import { useSonGuessrStore } from "@/stores/UseSonGuessrStore";
import { PlayerList } from "./PlayerList";

const createMockPlayer = (overrides: Partial<SonGuessrPlayerView> = {}): SonGuessrPlayerView => ({
  id: "player-1",
  name: "测试玩家",
  score: 10,
  membership: "active",
  online: true,
  isReady: true,
  isBot: false,
  isHost: false,
  roundStatus: "waiting",
  correctGuesses: 0,
  totalGuesses: 0,
  guessesUsed: 0,
  ...overrides,
});

describe("SonGuessr PlayerList", () => {
  it("渲染房主标识与玩家基础信息", () => {
    const players: SonGuessrPlayerView[] = [
      createMockPlayer({ id: "host-1", name: "房主小艾", isHost: true }),
      createMockPlayer({ id: "player-2", name: "普通玩家", isHost: false }),
    ];

    render(
      <PlayerList
        players={players}
        myPlayerId="host-1"
        isHost
        phase="waiting"
        allowSpectators
      />,
    );

    expect(screen.getByText("房主小艾")).toBeInTheDocument();
    expect(screen.getByText("普通玩家")).toBeInTheDocument();
    expect(screen.getByLabelText("房主")).toBeInTheDocument();
  });

  it("在等待阶段正确展示准备与等待就绪状态徽章", () => {
    const players: SonGuessrPlayerView[] = [
      createMockPlayer({ id: "p1", name: "已准备玩家", isReady: true }),
      createMockPlayer({ id: "p2", name: "未准备玩家", isReady: false }),
    ];

    render(
      <PlayerList
        players={players}
        myPlayerId="p1"
        isHost={false}
        phase="waiting"
        allowSpectators
      />,
    );

    expect(screen.getByText("准备")).toBeInTheDocument();
    expect(screen.getByText("等待")).toBeInTheDocument();
  });

  it("在进行中阶段正确展示抢答中、答对与出题状态", () => {
    const players: SonGuessrPlayerView[] = [
      createMockPlayer({ id: "p1", name: "出题人", roundStatus: "submitter" }),
      createMockPlayer({ id: "p2", name: "猜歌中玩家", roundStatus: "guessing" }),
      createMockPlayer({ id: "p3", name: "已答对玩家", roundStatus: "correct" }),
    ];

    render(
      <PlayerList
        players={players}
        myPlayerId="p1"
        isHost={false}
        phase="playing"
        allowSpectators
      />,
    );

    expect(screen.getByText("出题")).toBeInTheDocument();
    expect(screen.getByText("猜歌")).toBeInTheDocument();
    expect(screen.getByText("猜中")).toBeInTheDocument();
  });

  it("准确展示玩家得分数字与分值单位", () => {
    const players: SonGuessrPlayerView[] = [
      createMockPlayer({ id: "p1", name: "高分玩家", score: 88 }),
    ];

    render(
      <PlayerList
        players={players}
        myPlayerId="p1"
        isHost={false}
        phase="playing"
        allowSpectators
      />,
    );

    expect(screen.getByText("88")).toBeInTheDocument();
    expect(screen.getByText("分")).toBeInTheDocument();
  });

  it("长昵称仍可完整识别并通过键盘打开管理操作", async () => {
    const user = userEvent.setup();
    const name = "这是一个需要截断展示的很长玩家昵称";
    const sendCommand = vi.fn().mockResolvedValue({});
    const originalSendCommand = useSonGuessrStore.getState().sendCommand;
    useSonGuessrStore.setState({ sendCommand });

    try {
      render(
        <PlayerList
          players={[createMockPlayer({ name, score: 12345 })]}
          myPlayerId="host"
          isHost
          phase="waiting"
          allowSpectators={false}
        />,
      );

      expect(screen.getByTitle(name)).toHaveTextContent(name);
      expect(screen.getByLabelText("12345 分")).toBeInTheDocument();
      await user.tab();
      expect(screen.getByRole("button", { name: `${name} 操作` })).toHaveFocus();
      await user.keyboard("{Enter}");
      await user.click(await screen.findByRole("button", { name: "转移房主" }));
      expect(sendCommand).toHaveBeenCalledWith("song.room.transferHost", { playerId: "player-1" });
    } finally {
      useSonGuessrStore.setState({ sendCommand: originalSendCommand });
    }
  });
});
