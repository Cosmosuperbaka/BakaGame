import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createDefaultCCBSettings, type CCBPrivateState, type CCBRoomSnapshot } from "@bakagame/shared";
import { useCCBStore } from "@/stores/UseCCBStore";
import { ccbWs } from "@/lib/CCBWs";
import { CCBGameArea } from "./CCBGameArea";
import { CCBSettingsForm } from "./CCBSettingsForm";

const room = (changes: Partial<CCBRoomSnapshot> = {}): CCBRoomSnapshot => ({
  roomId: "1234", source: "native", name: "角色房", visibility: "public", hasPassword: false, allowSpectators: true,
  hostPlayerId: "host", phase: "waiting", settings: createDefaultCCBSettings(2026),
  players: [{ id: "host", name: "房主", online: true, ready: false, team: null, membership: "active", score: 0, status: "waiting", attempts: 0, marks: "", syncCompleted: false }],
  roundNumber: 1, syncRound: 1, setterPlayerId: null, phaseDeadlineAt: null, chat: [], roundSummary: null, upstreamConnected: true, ...changes,
});
const privateState = (changes: Partial<CCBPrivateState> = {}): CCBPrivateState => ({
  playerId: "host", canGuess: false, canSurrender: false, canStart: true, canSetAnswer: false,
  guesses: [], answer: null, hints: [], imageHintAvailable: false, imageHintLevel: 0, deadlineAt: null, bannedCharacterIds: [], ...changes,
});
afterEach(() => { useCCBStore.getState().resetRoom(); vi.restoreAllMocks(); });

describe("CCB 操作区", () => {
  it("准备与随机出题使用真实命令", async () => {
    const user = userEvent.setup();
    const send = vi.spyOn(ccbWs, "send").mockResolvedValue({});
    useCCBStore.setState({ source: "native", roomId: "1234", sessionToken: "token" });
    render(<CCBGameArea snapshot={room()} privateState={privateState()} />);
    await user.click(screen.getByRole("button", { name: "准备" }));
    expect(send).toHaveBeenCalledWith("ccb.player.ready", { ready: true }, expect.objectContaining({ roomId: "1234" }));
    await user.click(screen.getByRole("button", { name: "随机出题" }));
    expect(send).toHaveBeenCalledWith("ccb.game.start", {}, expect.objectContaining({ timeout: 0 }));
  });

  it("同步等待时不提供重复猜测入口", () => {
    const snapshot = room({ phase: "guessing" });
    snapshot.settings.syncMode = true;
    snapshot.players[0] = { ...snapshot.players[0], status: "playing", syncCompleted: true };
    render(<CCBGameArea snapshot={snapshot} privateState={privateState()} />);
    expect(screen.getByText("本轮已完成，等待其他玩家")).toBeInTheDocument();
    expect(screen.queryByRole("textbox", { name: "搜索角色" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "查看图片提示" })).not.toBeInTheDocument();
  });

  it("原版准备题目期间没有不支持的取消按钮", () => {
    render(<CCBGameArea snapshot={room({ source: "original", phase: "preparing" })} privateState={privateState()} />);
    expect(screen.getByText("正在准备题目")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "取消本局" })).not.toBeInTheDocument();
  });

  it("设置面板覆盖四个玩法开关且只读玩家不能保存", () => {
    render(<CCBSettingsForm settings={createDefaultCCBSettings(2026)} editable={false} />);
    for (const name of ["角色全局 BP", "标签全局 BP", "同步模式", "血战模式"]) {
      expect(screen.getByRole("switch", { name })).toBeDisabled();
    }
    expect(screen.getByLabelText("猜测次数")).toHaveValue(10);
    expect(screen.queryByRole("button", { name: "保存设置" })).not.toBeInTheDocument();
  });
});
