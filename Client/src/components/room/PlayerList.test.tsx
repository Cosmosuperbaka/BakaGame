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

    expect(screen.getByLabelText("平民")).toHaveClass(
      "rounded",
      "bg-card",
      "px-1.5",
      "py-0.5",
      "text-blue-600",
    );
    expect(screen.getByLabelText("平民")).not.toHaveClass("border");
    expect(screen.getByText("准备")).toHaveClass("bg-card", "text-emerald-600");
    expect(screen.getByText("测试玩家").parentElement).toHaveClass("min-h-10", "gap-1", "py-1");
  });
});
