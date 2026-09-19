import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
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

  it("历史里的长昵称玩家仍可用键盘标记身份与管理", async () => {
    const user = userEvent.setup();
    const name = "这是发言历史里需要完整识别的长昵称";
    const onMarkChange = vi.fn();
    const onKick = vi.fn();
    render(
      <PlayerRow
        player={{ ...player, name, online: false }}
        myPlayerId="another-player"
        isHostViewer
        waitingPhase={false}
        mark="unknown"
        canMark
        availableMarks={["unknown", "civilian", "undercover"]}
        onMarkChange={onMarkChange}
        onKick={onKick}
        onTransferHost={vi.fn()}
        embedded
      />,
    );

    expect(screen.getByTitle(name)).toHaveTextContent(name);
    expect(screen.getByLabelText("已断线")).toBeInTheDocument();
    await user.tab();
    expect(screen.getByRole("button", { name: `${name} 操作` })).toHaveFocus();
    await user.keyboard(" ");
    await user.click(await screen.findByRole("button", { name: "卧底" }));
    expect(onMarkChange).toHaveBeenCalledWith(player.id, "undercover");
    await user.click(screen.getByRole("button", { name: "踢出玩家" }));
    expect(onKick).toHaveBeenCalledWith(player.id);
  });
});
