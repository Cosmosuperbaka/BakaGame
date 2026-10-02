import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createDefaultCCBSettings,
  type CCBCharacterView,
  type CCBPrivateState,
  type CCBRoomSnapshot,
  type CCBScoreDetail,
} from "@bakagame/shared";
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
    // 可访问名来自可见标签；没有候选时下拉框一并禁用，框内说明原因而不是留空。
    expect(screen.getByText("指定出题人").tagName).toBe("LABEL");
    expect(screen.getByRole("combobox", { name: "指定出题人" })).toBeDisabled();
    expect(screen.getByRole("combobox", { name: "指定出题人" })).toHaveTextContent("暂无可选出题人");
    view.rerender(<CCBGameArea snapshot={room()} privateState={privateState({ canStart: false, setterCandidateIds: ["host"] })} />);
    expect(screen.getByRole("button", { name: "手动出题" })).toBeEnabled();
  });

  it("公开玩家栏保留次数、同步提交与完整进度信息", () => {
    const snapshot = room({ phase: "guessing" });
    snapshot.settings.syncMode = true;
    snapshot.players[0] = { ...snapshot.players[0], status: "playing", attempts: 3, syncCompleted: true, marks: "❌❌✅" };
    render(<CCBPlayerList snapshot={snapshot} privateState={privateState()} />);
    expect(screen.getByText("3/10 次 · 已提交")).toBeInTheDocument();
    // 进度以图标呈现，整串作为一个图像读给读屏，文字描述同时出现在悬停提示里。
    const marks = screen.getByLabelText("房主 猜测进度：未命中、未命中、猜中");
    expect(marks).toHaveAttribute("title", "房主 猜测进度：未命中、未命中、猜中");
    expect(marks.querySelectorAll("svg")).toHaveLength(3);
  });

  it("出题人在玩家栏标为「出题」，旁观分组不重复旁观状态", () => {
    const [host] = room().players;
    const snapshot = room({
      phase: "guessing", setterPlayerId: "host",
      players: [
        { ...host, status: "observing" },
        { ...host, id: "peach", name: "桃子", status: "playing", attempts: 1, marks: "❌" },
        { ...host, id: "late", name: "路人", membership: "spectator", status: "observing" },
      ],
    });
    render(<CCBPlayerList snapshot={snapshot} privateState={privateState()} />);
    expect(screen.getByText("出题")).toBeInTheDocument();
    expect(screen.getByText("猜测中")).toBeInTheDocument();
    // 「旁观」只剩分组标题，旁观者行不再重复同一个词。
    expect(screen.getAllByText("旁观")).toHaveLength(1);
  });

  it("旁观切换挂在目标分组下方，空旁观分组只在可加入时出现", async () => {
    const user = userEvent.setup();
    const send = vi.spyOn(ccbWs, "send").mockResolvedValue({});
    useCCBStore.setState({ source: "native", roomId: "1234", sessionToken: "token" });
    const [host] = room().players;
    const view = render(<CCBPlayerList snapshot={room()} privateState={privateState()} />);
    expect(screen.getByText("旁观")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "加入旁观" }));
    expect(send).toHaveBeenCalledWith("ccb.player.spectate", { spectator: true }, expect.objectContaining({ roomId: "1234" }));
    expect(screen.getByRole("combobox", { name: "我的队伍" })).toBeInTheDocument();

    // 房间关闭观战后，空分组与入口一起收起。
    view.rerender(<CCBPlayerList snapshot={room({ allowSpectators: false })} privateState={privateState()} />);
    expect(screen.queryByText("旁观")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "加入旁观" })).not.toBeInTheDocument();

    // 已在旁观的人仍能回到玩家组，入口接在玩家分组之后；旁观者没有队伍可选。
    const watching = room({ allowSpectators: false, players: [{ ...host, membership: "spectator", status: "observing" }] });
    view.rerender(<CCBPlayerList snapshot={watching} privateState={privateState()} />);
    expect(screen.queryByRole("combobox", { name: "我的队伍" })).not.toBeInTheDocument();
    await waitFor(() => expect(screen.getByRole("button", { name: "取消旁观" })).toBeEnabled());
    await user.click(screen.getByRole("button", { name: "取消旁观" }));
    expect(send).toHaveBeenCalledWith("ccb.player.spectate", { spectator: false }, expect.objectContaining({ roomId: "1234" }));

    // 开局后身份锁定，两种来源都不接受切换。
    view.rerender(<CCBPlayerList snapshot={{ ...watching, phase: "guessing" }} privateState={privateState()} />);
    expect(screen.queryByRole("button", { name: /旁观/ })).not.toBeInTheDocument();
  });

  it("出题人与本局观战者看到身份说明而不是猜测次数", () => {
    const [host] = room().players;
    const view = render(<CCBGameArea snapshot={room({ phase: "guessing", setterPlayerId: "host", players: [{ ...host, status: "observing" }] })} privateState={privateState()} />);
    expect(screen.getByText("你是本局出题人")).toBeInTheDocument();
    expect(screen.queryByText(/已用/)).not.toBeInTheDocument();
    // 中途加入者与出题人队友有席位，但本局同样观战。
    view.rerender(<CCBGameArea snapshot={room({ phase: "guessing", players: [{ ...host, status: "observing" }] })} privateState={privateState()} />);
    expect(screen.getByText("本局观战")).toBeInTheDocument();
    expect(screen.queryByText(/已用/)).not.toBeInTheDocument();
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
    const unlisted = screen.getByRole("switch", { name: "不在大厅显示" });
    expect(unlisted).toHaveAccessibleDescription("开启后不在大厅列出，凭链接仍可进入。");
    await user.click(unlisted);
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

  it("结算表按名次排列：猜中者在前，没有名次的保持服务端顺序", () => {
    // 带图片地址时角色图不再走懒加载的 IntersectionObserver（jsdom 没有）。
    const answer: CCBCharacterView = {
      id: 1, name: "Nijika", nameCn: "伊地知虹夏", gender: "female", popularity: 0, summary: "",
      imageUrl: "data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7",
      appearances: [], highestRating: -1, earliestAppearance: 0, latestAppearance: 0,
      subjectTags: [], characterTags: [], voiceActors: [], metaTags: [], comparisonAppearances: [], extraTags: [],
    };
    const line = (playerName: string, changes: Partial<CCBScoreDetail> = {}): CCBScoreDetail => ({
      playerId: playerName, playerName, score: 0, base: 0, firstGuess: 0, quickGuess: 0, partial: 0, setter: 0, reason: "", ...changes,
    });
    // 服务端按参与者顺序给出，猜中者的名次与座位无关。
    const scores = [
      line("作品命中", { score: 1, partial: 1, reason: "猜中共同作品" }),
      line("第二名", { score: 2, base: 2, reason: "猜中角色", rank: 2 }),
      line("未猜中"),
      line("第一名", { score: 4, base: 2, quickGuess: 2, reason: "猜中角色", rank: 1 }),
      line("出题人", { score: -1, setter: -1, reason: "太简单了" }),
    ];
    render(<CCBGameArea snapshot={room({ phase: "settled", roundSummary: { answer, scores, guesses: [], winners: [] } })} privateState={privateState()} />);
    const rows = within(screen.getByRole("table", { name: "本局得分" })).getAllByRole("rowheader");
    expect(rows.map((row) => row.textContent)).toEqual(
      ["第一名", "第二名", "作品命中", "未猜中", "出题人"].map((name) => expect.stringMatching(new RegExp(`^${name}`))),
    );
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
