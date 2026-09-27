import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect, screen, userEvent, waitFor, within } from "storybook/test";
import { whoIsFakerWsClient } from "@/lib/WhoIsFakerWs";
import { useWhoIsFakerStore } from "@/stores/UseWhoIsFakerStore";
import { dropFocus } from "@/stories/PlayHelpers";
import { ROOM_ID_TEST_MODE } from "@/types";
import {
  presetWifRoom,
  readyPlayers,
  seedWifUsername,
  undercoverWinnerSummary,
  WIF_PEOPLE,
  WIF_ROOM_ROUTER,
  WIF_TEST_ROUTER,
  wifPrivate,
  wifSnapshot,
} from "@/stories/fixtures/WhoIsFaker";
import WhoIsFakerRoomPage from "./WhoIsFakerRoomPage";

const { me, peach, kanade, kita } = WIF_PEOPLE;

const meta = {
  title: "页面/谁是卧底房间",
  component: WhoIsFakerRoomPage,
  tags: ["page"],
  parameters: { layout: "fullscreen", router: WIF_ROOM_ROUTER },
} satisfies Meta<typeof WhoIsFakerRoomPage>;

export default meta;
type Story = StoryObj<typeof meta>;

const MOBILE = { viewport: { value: "mobile", isRotated: false } };

/** 让进房流程越过“等待连接”：只替换连接就绪检查，不建立任何 WebSocket。 */
function connectInstantly() {
  Object.defineProperty(whoIsFakerWsClient, "waitForConnection", { configurable: true, value: () => Promise.resolve() });
  return () => {
    Reflect.deleteProperty(whoIsFakerWsClient, "waitForConnection");
  };
}

const asHost = wifPrivate("host", "day2");
const asMe = wifPrivate("me", "day2");

// ==================== 入房 ====================

/** 未入房且连接尚未就绪：停在加载指示（8 秒连接超时后会返回大厅）。 */
export const Joining: Story = {
  name: "正在加入房间",
  beforeEach: () => {
    const restoreName = seedWifUsername(me.name);
    return () => restoreName();
  },
};

export const NameDialog: Story = {
  name: "设置用户名",
  tags: ["!page", "overlay"],
  beforeEach: () => {
    const restoreName = seedWifUsername("");
    const restoreConnection = connectInstantly();
    return () => {
      restoreConnection();
      restoreName();
    };
  },
  play: async () => {
    await screen.findByRole("dialog", { name: "设置用户名" });
  },
};

// ==================== 等待阶段 ====================

export const WaitingHost: Story = {
  name: "等待阶段 · 房主",
  beforeEach: () => presetWifRoom(wifSnapshot("waiting", { players: readyPlayers() }), wifPrivate("host", "waiting")),
};

export const WaitingPlayer: Story = {
  name: "等待阶段 · 玩家",
  beforeEach: () => presetWifRoom(wifSnapshot("waiting"), wifPrivate("me", "waiting")),
};

export const WaitingSpectator: Story = {
  name: "等待阶段 · 旁观",
  beforeEach: () => presetWifRoom(wifSnapshot("waiting"), wifPrivate("spectator", "waiting")),
};

// ==================== 指定主持人 ====================

export const AssigningHost: Story = {
  name: "指定主持人 · 房主",
  beforeEach: () => presetWifRoom(wifSnapshot("assigning"), wifPrivate("host", "assigning")),
};

export const AssigningPlayer: Story = {
  name: "指定主持人 · 玩家",
  beforeEach: () => presetWifRoom(wifSnapshot("assigning"), wifPrivate("me", "assigning")),
};

// ==================== 出题 ====================

export const SubmittingWords: Story = {
  name: "出题阶段 · 主持人",
  beforeEach: () => presetWifRoom(wifSnapshot("words"), wifPrivate("host", "words")),
};

export const WaitingWords: Story = {
  name: "出题阶段 · 等待出题",
  beforeEach: () => presetWifRoom(wifSnapshot("words"), wifPrivate("me", "words")),
};

// ==================== 描述 ====================

export const DescribingPlayer: Story = {
  name: "描述阶段 · 玩家 · 未发言",
  beforeEach: () => presetWifRoom(wifSnapshot("day2"), asMe),
};

export const DescribingHost: Story = {
  name: "描述阶段 · 主持人",
  beforeEach: () => presetWifRoom(wifSnapshot("day2"), asHost),
};

export const DescribingSpectator: Story = {
  name: "描述阶段 · 旁观",
  beforeEach: () => presetWifRoom(wifSnapshot("day2"), wifPrivate("spectator", "day2")),
};

export const Supplement: Story = {
  name: "补充发言 · 玩家",
  beforeEach: () => presetWifRoom(wifSnapshot("sup2"), wifPrivate(kanade, "sup2")),
};

export const SupplementHost: Story = {
  name: "补充发言 · 主持人",
  beforeEach: () => presetWifRoom(wifSnapshot("sup2"), asHost),
};

export const TieBreak: Story = {
  name: "平票 PK · 描述",
  beforeEach: () => presetWifRoom(wifSnapshot("tie2"), wifPrivate(peach, "tie2")),
};

export const TieBreakVote: Story = {
  name: "平票 PK · 投票",
  beforeEach: () => presetWifRoom(wifSnapshot("tieVote2"), wifPrivate(peach, "tieVote2")),
};

// ==================== 投票 ====================

export const VotingPlayer: Story = {
  name: "投票阶段 · 玩家 · 未投票",
  beforeEach: () => presetWifRoom(wifSnapshot("vote3"), wifPrivate("me", "vote3")),
};

export const VotedPlayer: Story = {
  name: "投票阶段 · 玩家 · 已投票",
  beforeEach: () => presetWifRoom(
    wifSnapshot("vote3"),
    wifPrivate("me", "vote3", { myCurrentVoteTargetId: WIF_PEOPLE.yuzu.id }),
  ),
};

export const VotingHost: Story = {
  name: "投票阶段 · 主持人",
  beforeEach: () => presetWifRoom(wifSnapshot("vote3"), asHost),
};

export const VotingSpectator: Story = {
  name: "投票阶段 · 旁观",
  beforeEach: () => presetWifRoom(wifSnapshot("vote3"), wifPrivate("spectator", "vote3")),
};

// ==================== 夜晚 ====================

export const NightPlayer: Story = {
  name: "夜晚阶段 · 玩家 · 未行动",
  beforeEach: () => presetWifRoom(wifSnapshot("night2"), wifPrivate("me", "night2")),
};

export const NightActed: Story = {
  name: "夜晚阶段 · 玩家 · 已行动",
  beforeEach: () => presetWifRoom(
    wifSnapshot("night2"),
    wifPrivate("me", "night2", { nightActionSubmitted: true, myCurrentNightTargetId: WIF_PEOPLE.long.id }),
  ),
};

export const NightHost: Story = {
  name: "夜晚阶段 · 主持人",
  beforeEach: () => presetWifRoom(wifSnapshot("night2"), asHost),
};

// ==================== 白板猜词 ====================

export const BlankGuessing: Story = {
  name: "白板猜词 · 输入中",
  beforeEach: () => presetWifRoom(wifSnapshot("blankGuess"), wifPrivate(kita, "blankGuess", { canSubmitBlankGuess: true })),
};

export const BlankReviewing: Story = {
  name: "白板猜词 · 等待裁定",
  beforeEach: () => presetWifRoom(
    wifSnapshot("blankReview"),
    wifPrivate(kita, "blankReview", { canSubmitBlankGuess: false, blankGuessUsed: true }),
  ),
};

export const BlankWatchingHost: Story = {
  name: "白板猜词 · 主持人",
  beforeEach: () => presetWifRoom(wifSnapshot("blankGuess"), asHost),
};

// ==================== 游戏结束 ====================

export const GameOverHost: Story = {
  name: "游戏结束 · 房主 · 白板胜",
  beforeEach: () => presetWifRoom(wifSnapshot("over"), wifPrivate("host", "over")),
};

export const GameOverPlayer: Story = {
  name: "游戏结束 · 玩家",
  beforeEach: () => presetWifRoom(wifSnapshot("over"), wifPrivate("me", "over")),
};

export const GameOverUndercoverWin: Story = {
  name: "游戏结束 · 卧底胜",
  beforeEach: () => presetWifRoom(
    wifSnapshot("over", { summary: undercoverWinnerSummary() }),
    wifPrivate(peach, "over"),
  ),
};

// ==================== 测试房间 ====================

export const TestRoom: Story = {
  name: "测试房间 · 阶段控制器",
  parameters: { router: WIF_TEST_ROUTER },
  beforeEach: () => {
    const snapshot = wifSnapshot("day2", { roomId: ROOM_ID_TEST_MODE, name: "测试房间", testMode: true });
    presetWifRoom(snapshot, wifPrivate("host", "day2"));
  },
};

// ==================== 发言历史 ====================

export const HistoryExpanded: Story = {
  name: "描述阶段 · 展开发言历史",
  beforeEach: () => presetWifRoom(wifSnapshot("day2"), asMe),
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    // 窄视口下这里点开的是移动端覆盖面板，它由 Radix 渲染：打开后其余内容对读屏隐藏，
    // 入口按钮本身也会被标成 aria-hidden，因此持有原引用断言，不按名称重查。
    const toggle = canvas.getAllByRole("button", { name: "展开发言历史" })[0];
    await userEvent.click(toggle);
    await waitFor(() => expect(toggle).toHaveAttribute("aria-expanded", "true"));
    dropFocus();
  },
};

// ==================== 移动端覆盖面板 ====================

export const MobilePlayers: Story = {
  name: "移动端 · 玩家列表",
  tags: ["mobile"],
  globals: MOBILE,
  beforeEach: () => presetWifRoom(wifSnapshot("day2"), asMe),
  play: async ({ canvasElement }) => {
    const toggle = within(canvasElement).getByRole("button", { name: "玩家列表" });
    await userEvent.click(toggle);
    await waitFor(() => expect(toggle).toHaveAttribute("aria-expanded", "true"));
    dropFocus();
  },
};

export const MobileChat: Story = {
  name: "移动端 · 聊天",
  tags: ["mobile"],
  globals: MOBILE,
  beforeEach: () => presetWifRoom(wifSnapshot("day2"), asMe),
  play: async ({ canvasElement }) => {
    const toggle = within(canvasElement).getByRole("button", { name: "聊天" });
    await userEvent.click(toggle);
    await waitFor(() => expect(toggle).toHaveAttribute("aria-expanded", "true"));
    dropFocus();
  },
};

export const MobileHistory: Story = {
  name: "移动端 · 发言历史",
  tags: ["mobile"],
  globals: MOBILE,
  beforeEach: () => presetWifRoom(wifSnapshot("day2"), asMe),
  play: async ({ canvasElement }) => {
    const toggle = within(canvasElement).getByRole("button", { name: "展开发言历史" });
    await userEvent.click(toggle);
    await waitFor(() => expect(toggle).toHaveAttribute("aria-expanded", "true"));
    dropFocus();
  },
};

// ==================== 断线 ====================

export const Disconnected: Story = {
  name: "等待阶段 · 断线中",
  beforeEach: () => {
    presetWifRoom(wifSnapshot("waiting"), wifPrivate("me", "waiting"));
    useWhoIsFakerStore.setState({ connected: false });
  },
};
