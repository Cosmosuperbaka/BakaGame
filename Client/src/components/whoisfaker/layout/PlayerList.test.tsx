import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import type { PublicPlayerView } from "@/types";

import { PlayerRow } from "./PlayerList";

const player: PublicPlayerView = {
  id: "player-1",
  name: "测试玩家",
  score: 2,
  membership: "active",
  online: true,
  isReady: true,
  isBot: false,
  isHost: false,
  roundStatus: "waiting",
};

describe("player row presentation", () => {
  it("uses high-contrast compact badges for role and ready state", () => {
    render(
      <PlayerRow
        player={player}
        myPlayerId="another-player"
        isHostViewer={false}
        waitingPhase
        actualRole="civilian"
        mark="unknown"
        canMark={false}
        availableMarks={["unknown", "civilian", "undercover"]}
        onMarkChange={vi.fn()}
        onKick={vi.fn()}
        onTransferHost={vi.fn()}
      />,
    );

    // 验证核心业务属性的无障碍与语义呈现，不绑定原子类与 DOM 层级
    expect(screen.getByText("测试玩家")).toBeInTheDocument();
    expect(screen.getByLabelText("平民")).toBeInTheDocument();
    expect(screen.getByLabelText("平民")).toHaveTextContent("平民");
    expect(screen.getByText("准备")).toBeInTheDocument();
    expect(screen.getByText("2")).toBeInTheDocument();
    expect(screen.getByText("分")).toBeInTheDocument();
  });
});
