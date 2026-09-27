import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createDefaultCCBSettings, type CCBPrivateState, type CCBRoomSnapshot } from "@bakagame/shared";
import { useCCBStore } from "@/stores/UseCCBStore";
import { ccbWs } from "@/lib/CCBWs";
import { CCBGameArea } from "./CCBGameArea";
import { CCBGameSettings } from "./CCBGameSettings";
import { CCBPlayerList } from "./CCBPlayerList";

const room = (changes: Partial<CCBRoomSnapshot> = {}): CCBRoomSnapshot => ({
  roomId: "1234", source: "native", name: "角色房", visibility: "public", hasPassword: false, allowSpectators: true,
  hostPlayerId: "host", phase: "waiting", settings: createDefaultCCBSettings(2026),
  players: [{ id: "host", name: "房主", online: true, ready: false, team: null, membership: "active", score: 0, status: "waiting", attempts: 0, marks: "", syncCompleted: false }],
  roundNumber: 1, syncRound: 1, setterPlayerId: null, phaseDeadlineAt: null, chat: [], roundSummary: null, upstreamConnected: true, ...changes,
});
const privateState = (changes: Partial<CCBPrivateState> = {}): CCBPrivateState => ({
  playerId: "host", canGuess: false, canSurrender: false, canStart: true, canSetAnswer: false,
  guesses: [], answer: null, hints: [], imageHintAvailable: false, imageHintLevel: 0, deadlineAt: null, bannedCharacterIds: [], setterCandidateIds: ["host"], ...changes,
});
afterEach(() => { useCCBStore.getState().resetRoom(); vi.restoreAllMocks(); });

describe("CCB 操作区", () => {
  it("手动出题使用服务端候选权限，不受随机出题准备状态限制", async () => {
    const user = userEvent.setup();
    const send = vi.spyOn(ccbWs, "send").mockResolvedValue({});
    useCCBStore.setState({ source: "native", roomId: "1234", sessionToken: "token" });
    const view = render(<CCBGameArea snapshot={room()} privateState={privateState({ canStart: false })} />);
    expect(screen.getByRole("button", { name: "随机出题" })).toBeDisabled();
    await user.click(screen.getByRole("button", { name: "手动出题" }));
    expect(send).toHaveBeenCalledWith("ccb.game.chooseSetter", { playerId: "host" }, expect.any(Object));
    view.rerender(<CCBGameArea snapshot={room()} privateState={privateState({ canStart: false, setterCandidateIds: [] })} />);
    expect(screen.getByRole("button", { name: "手动出题" })).toBeDisabled();
    view.rerender(<CCBGameArea snapshot={room()} privateState={privateState({ canStart: false, setterCandidateIds: ["host"] })} />);
    expect(screen.getByRole("button", { name: "手动出题" })).toBeEnabled();
  });

  it("公开玩家栏保留次数、同步提交与完整进度信息", () => {
    const snapshot = room({ phase: "guessing" });
    snapshot.settings.syncMode = true;
    snapshot.players[0] = { ...snapshot.players[0], status: "playing", attempts: 3, syncCompleted: true, marks: "❌❌✅" };
    render(<CCBPlayerList snapshot={snapshot} privateState={privateState()} />);
    expect(screen.getByText("3/10 次 · 已提交")).toBeInTheDocument();
    expect(screen.getByLabelText("房主 猜测进度：❌❌✅")).toHaveAttribute("title", "❌❌✅");
  });

  it("原版房主可以改房名与大厅可见性且没有禁用旁观入口", async () => {
    const user = userEvent.setup();
    const send = vi.spyOn(ccbWs, "send").mockResolvedValue({});
    useCCBStore.setState({ source: "original", roomId: "1234", sessionToken: "token" });
    render(<CCBGameArea snapshot={room({ source: "original" })} privateState={privateState()} />);
    await user.click(screen.getByText("房间设置", { exact: true }));
    expect(screen.getByRole("textbox", { name: "房间名称" })).toHaveAttribute("maxlength", "30");
    await user.clear(screen.getByRole("textbox", { name: "房间名称" }));
    await user.type(screen.getByRole("textbox", { name: "房间名称" }), "新房间");
    await user.click(screen.getByRole("switch", { name: "公开显示在大厅" }));
    expect(screen.queryByRole("switch", { name: "允许旁观" })).not.toBeInTheDocument();
    // 改动防抖后自动保存；原版房没有密码机制，载荷里的密码恒为 null。
    await waitFor(() => expect(send).toHaveBeenCalledWith(
      "ccb.room.update",
      { name: "新房间", visibility: "private", allowSpectators: true, password: null },
      expect.any(Object),
    ));
  });

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

  it("原生房主仅在准备或出题阶段可以取消本局", async () => {
    const view = render(<CCBGameArea snapshot={room({ phase: "preparing" })} privateState={privateState()} />);
    expect(screen.getByRole("button", { name: "取消本局" })).toBeInTheDocument();
    view.rerender(<CCBGameArea snapshot={room({ phase: "guessing" })} privateState={privateState({ canGuess: true })} />);
    // 阶段切换是带退场的过渡，旧内容在新阶段进场前仍挂着，等它退完再断言。
    await waitFor(() => expect(screen.queryByRole("button", { name: "取消本局" })).not.toBeInTheDocument());
  });

  it("设置面板覆盖四个玩法开关，且只在实际生效的阶段提交草稿", async () => {
    const user = userEvent.setup();
    const send = vi.spyOn(ccbWs, "send").mockResolvedValue({});
    useCCBStore.setState({ source: "native", roomId: "1234", sessionToken: "token" });
    const settings = createDefaultCCBSettings(2026);
    const view = render(<CCBGameSettings settings={settings} waiting={false} />);
    await user.click(screen.getByRole("button", { name: /猜测设置/ }));
    for (const name of ["角色全局 BP", "标签全局 BP", "同步模式", "血战模式"]) {
      expect(screen.getByRole("switch", { name })).toBeInTheDocument();
    }
    // 开局后改动只留在草稿里，等待阶段守卫拦下保存。
    await user.click(screen.getByRole("switch", { name: "同步模式" }));
    expect(screen.getByRole("switch", { name: "同步模式" })).toBeChecked();
    expect(send).not.toHaveBeenCalled();

    view.rerender(<CCBGameSettings settings={settings} waiting />);
    await waitFor(() => expect(send).toHaveBeenCalledWith(
      "ccb.room.settings",
      { settings: expect.objectContaining({ syncMode: true }) },
      expect.any(Object),
    ));
  });
});
