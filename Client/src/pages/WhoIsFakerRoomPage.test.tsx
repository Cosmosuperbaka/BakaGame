import { StrictMode } from "react";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("framer-motion", async (importOriginal) => {
  const actual = await importOriginal<typeof import("framer-motion")>();
  return {
    ...actual,
    AnimatePresence: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  };
});

import { useWhoIsFakerStore } from "@/stores/UseWhoIsFakerStore";
import { stubMatchMedia } from "@/test/MatchMedia";
import type { WhoIsFakerPrivateState, WhoIsFakerRoomSnapshot } from "@bakagame/shared";
import WhoIsFakerRoomPage from "./WhoIsFakerRoomPage";

const initialStoreState = useWhoIsFakerStore.getState();

const createMockSnapshot = (
  overrides: Partial<WhoIsFakerRoomSnapshot> = {}
): WhoIsFakerRoomSnapshot => ({
  roomId: "FAKER_ROOM",
  name: "卧底测试房",
  visibility: "public",
  allowSpectators: true,
  hasPassword: false,
  hostPlayerId: "player-1",
  testMode: false,
  roleLimits: {
    maxUndercoverCount: 2,
    canEnableAngel: true,
    canEnableBlank: true,
  },
  settings: {
    roleConfig: {
      undercoverCount: 1,
      hasAngel: false,
      hasBlank: true,
    },
  },
  status: {
    phase: "waiting",
    roundId: "round-100",
    started: false,
    day: 0,
  },
  players: [
    {
      id: "player-1",
      name: "房主小明",
      score: 10,
      membership: "active",
      online: true,
      isReady: true,
      isBot: false,
      isHost: true,
      roundStatus: "waiting",
    },
    {
      id: "player-2",
      name: "玩家小红",
      score: 5,
      membership: "active",
      online: true,
      isReady: true,
      isBot: false,
      isHost: false,
      roundStatus: "waiting",
    },
    {
      id: "player-3",
      name: "玩家小强",
      score: 8,
      membership: "active",
      online: true,
      isReady: true,
      isBot: false,
      isHost: false,
      roundStatus: "waiting",
    },
  ],
  descriptions: [],
  chat: [],
  ...overrides,
});

const createMockPrivateState = (
  overrides: Partial<WhoIsFakerPrivateState> = {}
): WhoIsFakerPrivateState => ({
  playerId: "player-1",
  sessionToken: "token-1",
  isQuestioner: false,
  canSubmitBlankGuess: false,
  blankGuessUsed: false,
  nightActionSubmitted: false,
  ...overrides,
});

/** 把房间推到某一局的某个阶段；不传 roundId 表示回到局外的等待阶段。 */
function setRoundPhase(phase: WhoIsFakerRoomSnapshot["status"]["phase"], roundId?: string) {
  const base = createMockSnapshot();
  act(() => {
    useWhoIsFakerStore.setState({
      snapshot: createMockSnapshot({
        status: {
          phase,
          roundId,
          started: roundId !== undefined,
          day: roundId === undefined ? 0 : 1,
          ...(phase === "description" ? { speechOrder: ["player-2", "player-3", "player-1"] } : {}),
        },
        players: base.players.map((player) => ({
          ...player,
          roundStatus: roundId === undefined ? "waiting" : "alive",
        })),
      }),
    });
  });
}

function renderRoomPage(roomId = "FAKER_ROOM") {
  return render(
    <MemoryRouter initialEntries={[`/whoisfaker/room/${roomId}`]}>
      <Routes>
        <Route path="/whoisfaker/room/:roomId" element={<WhoIsFakerRoomPage />} />
        <Route path="/whoisfaker" element={<div>WhoIsFaker 游戏大厅</div>} />
      </Routes>
    </MemoryRouter>
  );
}

describe("WhoIsFakerRoomPage 页面级集成测试", () => {
  beforeEach(() => {
    useWhoIsFakerStore.setState({
      ...initialStoreState,
      roomId: "FAKER_ROOM",
      connected: true,
      snapshot: createMockSnapshot(),
      privateState: createMockPrivateState(),
    });
  });

  afterEach(() => {
    useWhoIsFakerStore.setState(initialStoreState, true);
    vi.restoreAllMocks();
  });

  it("房主没开 MCP 时，顶栏设置面板里的接管开关禁用并说明原因", async () => {
    renderRoomPage();
    fireEvent.click(screen.getByRole("button", { name: "设置" }));

    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByRole("switch", { name: /交给 Agent 操作/ })).toBeDisabled();
    expect(dialog).toHaveTextContent("本房间未开启 MCP");
  });

  it("房主开了 MCP 时，顶栏设置面板里的同一个开关可用", async () => {
    const base = createMockSnapshot();
    useWhoIsFakerStore.setState({
      snapshot: createMockSnapshot({ settings: { ...base.settings, allowAgents: true } }),
    });
    renderRoomPage();
    fireEvent.click(screen.getByRole("button", { name: "设置" }));

    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByRole("switch", { name: /交给 Agent 操作/ })).toBeEnabled();
    expect(dialog).not.toHaveTextContent("本房间未开启 MCP");
  });

  it("渲染等待阶段完整快照（房间名、房主控制区、规则配置与玩家列表）", () => {
    renderRoomPage();

    // 房间名与房间号
    expect(screen.getByRole("heading", { level: 1, name: "卧底测试房" })).toBeInTheDocument();
    expect(screen.getByText("#FAKER_ROOM")).toBeInTheDocument();

    // 房主控制区
    expect(screen.getByRole("button", { name: "开始游戏" })).toBeInTheDocument();
    expect(screen.getByText("房间设置")).toBeInTheDocument();

    // 玩家列表与准备状态徽章
    expect(screen.getByText("房主小明")).toBeInTheDocument();
    expect(screen.getByText("玩家小红")).toBeInTheDocument();
    expect(screen.getByText("玩家小强")).toBeInTheDocument();
    // 玩家列表只挂载一份（游戏区侧的桌面列），三名已准备玩家各一枚徽章
    expect(screen.getAllByText("准备")).toHaveLength(3);
  });

  it("发言阶段流转、发言记录呈现与投票面板交互", () => {
    const sendCommandSpy = vi.fn().mockResolvedValue({});
    useWhoIsFakerStore.setState({
      sendCommand: sendCommandSpy,
    });

    renderRoomPage();

    // 1. 流转到描述发言阶段
    act(() => {
      useWhoIsFakerStore.setState({
        snapshot: createMockSnapshot({
          status: {
            phase: "description",
            roundId: "round-100",
            started: true,
            day: 1,
            speechOrder: ["player-2", "player-3", "player-1"],
          },
          players: [
            {
              id: "player-1",
              name: "房主小明",
              score: 10,
              membership: "active",
              online: true,
              isReady: true,
              isBot: false,
              isHost: true,
              roundStatus: "alive",
            },
            {
              id: "player-2",
              name: "玩家小红",
              score: 5,
              membership: "active",
              online: true,
              isReady: true,
              isBot: false,
              isHost: false,
              roundStatus: "alive",
            },
            {
              id: "player-3",
              name: "玩家小强",
              score: 8,
              membership: "active",
              online: true,
              isReady: true,
              isBot: false,
              isHost: false,
              roundStatus: "alive",
            },
          ],
          descriptions: [
            {
              id: "desc-1",
              kind: "description",
              cycle: 1,
              playerId: "player-2",
              playerName: "玩家小红",
              text: "这个东西是圆形的",
              createdAt: Date.now(),
            },
          ],
        }),
        privateState: createMockPrivateState({
          word: "西瓜",
        }),
      });
    });

    expect(screen.getByText("第 1 天")).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "描述阶段" })).toBeInTheDocument();
    expect(screen.getByText("这个东西是圆形的")).toBeInTheDocument();

    // 2. 流转到投票阶段
    act(() => {
      useWhoIsFakerStore.setState({
        snapshot: createMockSnapshot({
          status: {
            phase: "voting",
            roundId: "round-100",
            started: true,
            day: 1,
          },
          players: [
            {
              id: "player-1",
              name: "房主小明",
              score: 10,
              membership: "active",
              online: true,
              isReady: true,
              isBot: false,
              isHost: true,
              roundStatus: "alive",
            },
            {
              id: "player-2",
              name: "玩家小红",
              score: 5,
              membership: "active",
              online: true,
              isReady: true,
              isBot: false,
              isHost: false,
              roundStatus: "alive",
            },
            {
              id: "player-3",
              name: "玩家小强",
              score: 8,
              membership: "active",
              online: true,
              isReady: true,
              isBot: false,
              isHost: false,
              roundStatus: "alive",
            },
          ],
        }),
        privateState: createMockPrivateState({
          myCurrentVoteTargetId: undefined,
        }),
      });
    });

    expect(screen.getByRole("heading", { name: "投票阶段" })).toBeInTheDocument();

    // 找到可投玩家并点击投票
    const voteButton = screen.getByRole("button", { name: "玩家小红" });
    fireEvent.click(voteButton);

    expect(sendCommandSpy).toHaveBeenCalledWith("game.submitVote", { targetId: "player-2" });
  });

  it("桌面发言历史只在展开它的那一局保持展开，回到等待后收起，下一局不自动弹开", () => {
    const { container } = renderRoomPage();
    setRoundPhase("description", "round-100");
    const pane = () => within(container.querySelector<HTMLElement>("section > aside")!);

    fireEvent.click(pane().getByRole("button", { name: "展开发言历史" }));
    expect(pane().getByRole("button", { name: "收起发言历史" })).toHaveAttribute(
      "aria-expanded",
      "true"
    );

    // 同一局内换阶段，展开状态保留
    setRoundPhase("voting", "round-100");
    expect(pane().getByRole("button", { name: "收起发言历史" })).toBeInTheDocument();

    // 回到等待：切换按钮隐藏，面板也不能继续盖住游戏区
    setRoundPhase("waiting");
    expect(pane().queryByRole("button", { name: /发言历史/ })).not.toBeInTheDocument();

    setRoundPhase("description", "round-101");
    expect(pane().getByRole("button", { name: "展开发言历史" })).toHaveAttribute(
      "aria-expanded",
      "false"
    );
  });

  describe("桌面发言历史展开时的键盘与读屏路径", () => {
    const aside = (container: HTMLElement) =>
      container.querySelector<HTMLElement>("section > aside")!;
    const game = (container: HTMLElement) => container.querySelector<HTMLElement>("main")!;

    it("展开后游戏区不可交互，收起后恢复", () => {
      const { container } = renderRoomPage();
      setRoundPhase("description", "round-100");
      expect(game(container).querySelector("[inert]")).toBeNull();

      fireEvent.click(within(aside(container)).getByRole("button", { name: "展开发言历史" }));
      expect(game(container).querySelector("[inert]")).not.toBeNull();

      fireEvent.click(within(aside(container)).getByRole("button", { name: "收起发言历史" }));
      expect(game(container).querySelector("[inert]")).toBeNull();
    });

    it("手机宽度下侧栏不存在，桌面展开的状态不让游戏区变成不可交互", () => {
      const media = stubMatchMedia(true);
      try {
        const { container } = renderRoomPage();
        setRoundPhase("description", "round-100");
        fireEvent.click(within(aside(container)).getByRole("button", { name: "展开发言历史" }));
        expect(game(container).querySelector("[inert]")).not.toBeNull();
        act(() => media.crossBreakpoint(false));
        expect(game(container).querySelector("[inert]")).toBeNull();
      } finally {
        vi.unstubAllGlobals();
      }
    });

    it("展开按钮用 aria-controls 指向侧栏", () => {
      const { container } = renderRoomPage();
      setRoundPhase("description", "round-100");
      const toggle = within(aside(container)).getByRole("button", { name: "展开发言历史" });
      expect(aside(container).id).not.toBe("");
      expect(toggle).toHaveAttribute("aria-controls", aside(container).id);
    });

    it("展开与 Escape 收起后，焦点都落在切换按钮上", () => {
      const { container } = renderRoomPage();
      setRoundPhase("description", "round-100");
      fireEvent.click(within(aside(container)).getByRole("button", { name: "展开发言历史" }));
      const toggle = within(aside(container)).getByRole("button", { name: "收起发言历史" });
      expect(toggle).toHaveFocus();

      // 焦点掉到页面根（原先所在的游戏区控件被置为不可交互）时，Escape 把焦点还给切换按钮
      toggle.blur();
      fireEvent.keyDown(document, { key: "Escape" });
      expect(within(aside(container)).getByRole("button", { name: "展开发言历史" })).toHaveFocus();
    });

    it("Escape 收起时不抢走聊天输入框里的焦点", () => {
      const { container } = renderRoomPage();
      setRoundPhase("description", "round-100");
      fireEvent.click(within(aside(container)).getByRole("button", { name: "展开发言历史" }));
      const outside = document.createElement("input");
      document.body.append(outside);
      outside.focus();
      fireEvent.keyDown(document, { key: "Escape" });
      expect(outside).toHaveFocus();
      outside.remove();
    });
  });

  it("手机发言历史抽屉在回到等待时关闭，下一局不会自己重新打开", () => {
    vi.stubGlobal("matchMedia", () => ({
      matches: false,
      addEventListener() {},
      removeEventListener() {},
    }));
    try {
      const { container } = renderRoomPage();
      setRoundPhase("description", "round-100");
      const header = () => within(container.querySelector<HTMLElement>("header")!);

      fireEvent.click(header().getByRole("button", { name: "展开发言历史" }));
      expect(screen.getByRole("dialog", { name: "发言历史" })).toBeInTheDocument();

      setRoundPhase("waiting");
      expect(screen.queryByRole("dialog", { name: "发言历史" })).not.toBeInTheDocument();

      setRoundPhase("description", "round-101");
      expect(screen.queryByRole("dialog", { name: "发言历史" })).not.toBeInTheDocument();
      expect(header().getByRole("button", { name: "展开发言历史" })).toHaveAttribute(
        "aria-expanded",
        "false"
      );
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("结算弹框展示：卧底胜利、词语揭秘全景与胜负原因", () => {
    renderRoomPage();

    act(() => {
      useWhoIsFakerStore.setState({
        snapshot: createMockSnapshot({
          status: {
            phase: "gameOver",
            roundId: "round-100",
            started: true,
            day: 2,
          },
          summary: {
            winner: "undercover",
            reason: "卧底成功隐藏到最后，获得胜利",
            awardedScores: [{ playerId: "player-2", delta: 3 }],
            revealedRoles: [
              { playerId: "player-1", role: "civilian" },
              { playerId: "player-2", role: "undercover" },
              { playerId: "player-3", role: "civilian" },
            ],
            descriptions: [],
            blankGuesses: [],
            words: {
              pair: ["西瓜", "冬瓜"],
              civilianWord: "西瓜",
              undercoverWord: "冬瓜",
            },
          },
        }),
      });
    });

    // 获胜标题与解密词语
    expect(screen.getByRole("heading", { name: "卧底阵营胜利" })).toBeInTheDocument();
    expect(screen.getByText("本局词语解密")).toBeInTheDocument();
    expect(screen.getByText("西瓜")).toBeInTheDocument();
    expect(screen.getByText("冬瓜")).toBeInTheDocument();
    expect(screen.getByText("身份揭示与得分统计")).toBeInTheDocument();

    // 得分与身份是结算的核心信息：身份徽章逐行对上，增量补正号，累计分取快照总分
    const table = within(screen.getByRole("table", { name: "身份揭示与得分统计" }));
    expect(table.getAllByText("平民")).toHaveLength(2);
    expect(table.getByText("卧底")).toBeInTheDocument();
    const undercoverRow = table.getByRole("row", { name: /玩家小红/ });
    expect(within(undercoverRow).getByText("+3")).toBeInTheDocument();
    expect(within(undercoverRow).getByText("5")).toBeInTheDocument();
  });

  it("白板胜利结算与词语提示展示", () => {
    renderRoomPage();

    act(() => {
      useWhoIsFakerStore.setState({
        snapshot: createMockSnapshot({
          status: {
            phase: "gameOver",
            roundId: "round-100",
            started: true,
            day: 1,
          },
          summary: {
            winner: "blank",
            reason: "白板成功猜对词语，获得胜利",
            awardedScores: [],
            revealedRoles: [
              { playerId: "player-1", role: "civilian" },
              { playerId: "player-2", role: "blank" },
            ],
            descriptions: [],
            blankGuesses: [],
            words: {
              pair: ["电脑", "平板"],
              civilianWord: "电脑",
              undercoverWord: "平板",
              blankHint: "电子设备",
            },
          },
        }),
      });
    });

    expect(screen.getByRole("heading", { name: "白板胜利" })).toBeInTheDocument();
    expect(screen.getByText("电脑")).toBeInTheDocument();
    expect(screen.getByText("平板")).toBeInTheDocument();
    expect(screen.getByText("电子设备")).toBeInTheDocument();
  });

  it("夜晚阶段：有行动资格的存活玩家看到候选目标，点选后提交夜间行动", async () => {
    const sendCommandSpy = vi.fn().mockResolvedValue({});
    useWhoIsFakerStore.setState({ sendCommand: sendCommandSpy });
    renderRoomPage();

    act(() => {
      useWhoIsFakerStore.setState({
        snapshot: createMockSnapshot({
          status: { phase: "night", roundId: "round-100", started: true, day: 1 },
          players: createMockSnapshot().players.map((player) => ({
            ...player,
            roundStatus: "alive",
          })),
        }),
        privateState: createMockPrivateState({ canActAtNight: true }),
      });
    });

    expect(screen.getByRole("heading", { name: "夜晚降临" })).toBeInTheDocument();
    // 自己永远不是夜晚目标，候选只剩另外两名存活玩家
    expect(screen.queryByRole("button", { name: "房主小明" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "玩家小红" }));
    await waitFor(() =>
      expect(sendCommandSpy).toHaveBeenCalledWith("game.submitNightAction", {
        targetId: "player-2",
      })
    );
  });

  it("白板猜词阶段：本人两词齐全后可提交，其他玩家看到谁在猜与原因", async () => {
    const sendCommandSpy = vi.fn().mockResolvedValue({});
    useWhoIsFakerStore.setState({ sendCommand: sendCommandSpy });
    renderRoomPage();

    act(() => {
      useWhoIsFakerStore.setState({
        snapshot: createMockSnapshot({
          status: {
            phase: "blankGuess",
            roundId: "round-100",
            started: true,
            day: 1,
            blankGuessPlayerId: "player-1",
            blankGuessReason: "active",
          },
          players: createMockSnapshot().players.map((player) => ({
            ...player,
            roundStatus: "alive",
          })),
        }),
        privateState: createMockPrivateState({ canSubmitBlankGuess: true }),
      });
    });

    expect(screen.getByRole("heading", { name: "白板猜词" })).toBeInTheDocument();
    const submit = screen.getByRole("button", { name: "提交猜测" });
    expect(submit).toBeDisabled();
    fireEvent.change(screen.getByLabelText("词语 A"), { target: { value: "西瓜" } });
    // 只填一个词还不够：两个词都要有。
    expect(submit).toBeDisabled();
    fireEvent.change(screen.getByLabelText("词语 B"), { target: { value: "冬瓜" } });
    expect(submit).toBeEnabled();
    fireEvent.click(submit);
    await waitFor(() =>
      expect(sendCommandSpy).toHaveBeenCalledWith("game.submitBlankGuess", {
        words: ["西瓜", "冬瓜"],
      })
    );

    // 换成旁观者视角：同页展示猜词人与进入猜词的原因
    act(() => {
      useWhoIsFakerStore.setState({
        privateState: createMockPrivateState({ playerId: "player-2" }),
      });
    });
    expect(screen.getByText("房主小明 正在猜词")).toBeInTheDocument();
    expect(screen.getByText("白板主动发起猜词")).toBeInTheDocument();
  });

  it("长连接断线状态展示与房间被关闭自动退出到大厅", () => {
    renderRoomPage();

    // 1. 断线状态下展示提示
    act(() => {
      useWhoIsFakerStore.setState({ connected: false });
    });
    // 顶栏 sm 起写成文字、更窄时收成图标，两处同一份文案
    expect(screen.getAllByText("断线中...").length).toBeGreaterThan(0);

    // 2. 房间被服务端关闭时，页面自动重定向到 /whoisfaker 大厅并清理关闭标记
    act(() => {
      useWhoIsFakerStore.setState({ roomClosedAt: Date.now() });
    });
    expect(screen.getByText("WhoIsFaker 游戏大厅")).toBeInTheDocument();
    expect(useWhoIsFakerStore.getState().roomClosedAt).toBeNull();
  });

  it("主动离开先换页、房间页卸载后才退房，严格模式下只退一次", () => {
    // 跨页过渡拍的是点击那一刻的旧页：先退房会清空快照，旧页就成了加入中的转圈。
    const lobbyShownAtLeave: boolean[] = [];
    const leaveRoom = vi.fn(async () => {
      lobbyShownAtLeave.push(screen.queryByText("WhoIsFaker 游戏大厅") !== null);
    });
    useWhoIsFakerStore.setState({ leaveRoom });
    render(
      <StrictMode>
        <MemoryRouter initialEntries={["/whoisfaker/room/FAKER_ROOM"]}>
          <Routes>
            <Route path="/whoisfaker/room/:roomId" element={<WhoIsFakerRoomPage />} />
            <Route path="/whoisfaker" element={<div>WhoIsFaker 游戏大厅</div>} />
          </Routes>
        </MemoryRouter>
      </StrictMode>
    );
    expect(leaveRoom).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "离开房间" }));

    expect(screen.getByText("WhoIsFaker 游戏大厅")).toBeInTheDocument();
    expect(leaveRoom).toHaveBeenCalledTimes(1);
    expect(lobbyShownAtLeave).toEqual([true]);
  });

  it("离开房间后再进入房间，清除历史关闭状态且绝不发生原地跳转", () => {
    useWhoIsFakerStore.setState({
      ...initialStoreState,
      connected: true,
      roomClosedAt: Date.now() - 3000,
      roomId: "6688",
      snapshot: createMockSnapshot({ roomId: "6688" }),
      privateState: createMockPrivateState(),
    });

    const { unmount } = render(
      <MemoryRouter initialEntries={["/whoisfaker/room/6688"]}>
        <Routes>
          <Route path="/whoisfaker/room/:roomId" element={<WhoIsFakerRoomPage />} />
          <Route path="/whoisfaker" element={<div>WhoIsFaker 游戏大厅</div>} />
        </Routes>
      </MemoryRouter>
    );

    expect(useWhoIsFakerStore.getState().roomClosedAt).toBeNull();
    expect(screen.queryByText("WhoIsFaker 游戏大厅")).not.toBeInTheDocument();
    unmount();
  });
});
