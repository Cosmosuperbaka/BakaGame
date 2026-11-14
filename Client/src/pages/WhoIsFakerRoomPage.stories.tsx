import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect, screen, userEvent, waitFor, within } from "storybook/test";
import { whoIsFakerWsClient } from "@/lib/WhoIsFakerWs";
import { useWhoIsFakerStore } from "@/stores/UseWhoIsFakerStore";
import { dropFocus } from "@/stories/PlayHelpers";
import { ROOM_ID_TEST_MODE } from "@bakagame/shared/values";
import {
  presetWifRoom,
  readyPlayers,
  seedWifUsername,
  wifEndingScenario,
  wifFeedbackSnapshot,
  WIF_PEOPLE,
  WIF_ROOM_ROUTER,
  WIF_TEST_ROUTER,
  wifPrivate,
  wifSnapshot,
} from "@/stories/fixtures/WhoIsFaker";
import WhoIsFakerRoomPage from "./WhoIsFakerRoomPage";
import { rejectedProtocol } from "@/lib/ProtocolFailure";

const { host, me, peach, azumi, kanade, kita } = WIF_PEOPLE;

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
  Object.defineProperty(whoIsFakerWsClient, "waitForConnection", {
    configurable: true,
    value: () => Promise.resolve(),
  });
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

/** 私密房直链：不带密码的加入被拒，落到输入密码步；刚到这一步不算失败，不写原因。 */
export const PasswordDialog: Story = {
  name: "输入房间密码",
  tags: ["!page", "overlay"],
  beforeEach: () => {
    const restoreName = seedWifUsername(me.name);
    const restoreConnection = connectInstantly();
    useWhoIsFakerStore.setState({ joinRoom: lockedJoin([]) });
    return () => {
      restoreConnection();
      restoreName();
    };
  },
  play: async () => {
    await screen.findByRole("dialog", { name: "输入房间密码" });
  },
};

/** 带密码的确认按这张表应答：第一次密码被拒写在框下，再交一次就停在在途。 */
function lockedJoin(attempts: Array<{ code: string; message: string } | "pending">) {
  let index = 0;
  return (_roomId: string, _name: string, password?: string) => {
    if (!password)
      return rejectedProtocol({ code: "PASSWORD_REQUIRED", message: "该房间需要密码" });
    const step = attempts[Math.min(index, attempts.length - 1)];
    index += 1;
    return step === "pending" ? new Promise<never>(() => {}) : rejectedProtocol(step);
  };
}

/** 在密码框里交一次密码；`settled` 是交完之后要等到的状态。 */
async function submitPassword(
  value: string,
  settled: (dialog: ReturnType<typeof within>) => Promise<unknown>
) {
  const dialog = within(await screen.findByRole("dialog", { name: "输入房间密码" }));
  await userEvent.type(dialog.getByLabelText("房间密码"), value);
  await userEvent.click(dialog.getByRole("button", { name: "加入房间" }));
  await settled(dialog);
  dropFocus();
}

/** 输错密码：原因写在密码框下并标红，不另弹提示条，留在这一步重输。 */
export const PasswordWrong: Story = {
  name: "输入房间密码 · 密码错误",
  tags: ["!page", "overlay"],
  beforeEach: () => {
    const restoreName = seedWifUsername(me.name);
    const restoreConnection = connectInstantly();
    useWhoIsFakerStore.setState({
      joinRoom: lockedJoin([{ code: "PASSWORD_INCORRECT", message: "房间密码错误" }]),
    });
    return () => {
      restoreConnection();
      restoreName();
    };
  },
  play: () => submitPassword("1234", (dialog) => dialog.findByText("房间密码错误")),
};

/** 尝试过多：留在密码步，原因写在框下但不标红（不是这次密码本身不对）。 */
export const PasswordTooMany: Story = {
  name: "输入房间密码 · 尝试过多",
  tags: ["!page", "overlay"],
  beforeEach: () => {
    const restoreName = seedWifUsername(me.name);
    const restoreConnection = connectInstantly();
    useWhoIsFakerStore.setState({
      joinRoom: lockedJoin([
        { code: "TOO_MANY_ATTEMPTS", message: "密码错误次数过多，请稍后再试" },
      ]),
    });
    return () => {
      restoreConnection();
      restoreName();
    };
  },
  play: () => submitPassword("1234", (dialog) => dialog.findByText("密码错误次数过多，请稍后再试")),
};

/** 确认在途：密码框留着，确认钮转圈并挡住重复提交。 */
export const PasswordPending: Story = {
  name: "输入房间密码 · 确认在途",
  tags: ["!page", "overlay"],
  beforeEach: () => {
    const restoreName = seedWifUsername(me.name);
    const restoreConnection = connectInstantly();
    useWhoIsFakerStore.setState({ joinRoom: lockedJoin(["pending"]) });
    return () => {
      restoreConnection();
      restoreName();
    };
  },
  play: () =>
    submitPassword("1234", (dialog) =>
      waitFor(() =>
        expect(dialog.getByRole("button", { name: "加入房间" })).toHaveAttribute(
          "aria-busy",
          "true"
        )
      )
    ),
};

// ==================== 等待阶段 ====================

export const WaitingHost: Story = {
  name: "等待阶段 · 房主",
  beforeEach: () =>
    presetWifRoom(
      wifSnapshot("waiting", { players: readyPlayers() }),
      wifPrivate("host", "waiting")
    ),
};

export const WaitingPlayer: Story = {
  name: "等待阶段 · 玩家",
  beforeEach: () => presetWifRoom(wifSnapshot("waiting"), wifPrivate("me", "waiting")),
};

export const WaitingSpectator: Story = {
  name: "等待阶段 · 旁观",
  beforeEach: () => presetWifRoom(wifSnapshot("waiting"), wifPrivate("spectator", "waiting")),
};

export const SettingsPanel: Story = {
  name: "设置面板 · 房主",
  beforeEach: () =>
    presetWifRoom(
      wifSnapshot("waiting", { players: readyPlayers() }),
      wifPrivate("host", "waiting")
    ),
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    for (const name of ["身份设置", "房间设置"])
      await userEvent.click(canvas.getByRole("button", { name }));
    dropFocus();
  },
};

/** 非房主展开两组设置：同一份结构，字段只显示取值。 */
export const SettingsPanelGuest: Story = {
  name: "设置面板 · 玩家 · 只读",
  beforeEach: () =>
    presetWifRoom(wifSnapshot("waiting", { players: readyPlayers() }), wifPrivate("me", "waiting")),
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    for (const name of ["身份设置", "房间设置"])
      await userEvent.click(canvas.getByRole("button", { name }));
    dropFocus();
  },
};

/** 只有三名参与者：卧底上限为 1，天使与白板不可开启；服务端已按上限夹过保存的角色配置。 */
export const SettingsPanelFewPlayers: Story = {
  name: "设置面板 · 房主 · 人数不足",
  beforeEach: () => {
    const present = new Set<string>([host.id, me.id, peach.id, azumi.id]);
    presetWifRoom(
      wifSnapshot("waiting", {
        players: readyPlayers().filter((player) => present.has(player.id)),
        roleLimits: { maxUndercoverCount: 1, canEnableAngel: false, canEnableBlank: false },
        settings: {
          roleConfig: { undercoverCount: 1, hasAngel: false, hasBlank: false },
          revealRoleOnDeath: true,
          // 服务端的默认值：旁观者局中看不到答案。
          spectatorsSeeAnswers: false,
        },
      }),
      wifPrivate("host", "waiting")
    );
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    for (const name of ["身份设置", "房间设置"])
      await userEvent.click(canvas.getByRole("button", { name }));
    dropFocus();
  },
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
  beforeEach: () =>
    presetWifRoom(
      wifSnapshot("vote3"),
      wifPrivate("me", "vote3", { myCurrentVoteTargetId: WIF_PEOPLE.yuzu.id })
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
  beforeEach: () =>
    presetWifRoom(
      wifSnapshot("night2"),
      wifPrivate("me", "night2", {
        nightActionSubmitted: true,
        myCurrentNightTargetId: WIF_PEOPLE.long.id,
      })
    ),
};

export const NightHost: Story = {
  name: "夜晚阶段 · 主持人",
  beforeEach: () => presetWifRoom(wifSnapshot("night2"), asHost),
};

// ==================== 白板猜词 ====================

export const BlankGuessing: Story = {
  name: "白板猜词 · 输入中",
  beforeEach: () =>
    presetWifRoom(
      wifSnapshot("blankGuess"),
      wifPrivate(kita, "blankGuess", { canSubmitBlankGuess: true })
    ),
};

export const BlankReviewing: Story = {
  name: "白板猜词 · 等待裁定",
  beforeEach: () =>
    presetWifRoom(
      wifSnapshot("blankReview"),
      wifPrivate(kita, "blankReview", { canSubmitBlankGuess: false, blankGuessUsed: true })
    ),
};

export const BlankWatchingHost: Story = {
  name: "白板猜词 · 主持人",
  beforeEach: () => presetWifRoom(wifSnapshot("blankGuess"), asHost),
};

// ==================== 阶段反馈 ====================

export const FeedbackVoteHost: Story = {
  name: "阶段反馈 · 投票结果 · 主持人",
  beforeEach: () => presetWifRoom(wifFeedbackSnapshot("vote"), wifPrivate("host", "night1")),
  play: async () => {
    await screen.findByRole("heading", { name: "第 1 天投票结果" });
    await screen.findByRole("button", { name: "进入夜晚" });
  },
};

export const FeedbackTiePlayer: Story = {
  name: "阶段反馈 · 平票 · 玩家",
  beforeEach: () => presetWifRoom(wifFeedbackSnapshot("tie"), wifPrivate("me", "tie2")),
  play: async () => {
    await screen.findByText("平票，进入 PK", { exact: false });
    await screen.findByText("等待主持人继续");
  },
};

export const FeedbackNight: Story = {
  name: "阶段反馈 · 天亮了",
  beforeEach: () => presetWifRoom(wifFeedbackSnapshot("night"), wifPrivate("me", "day2")),
  play: async () => {
    await screen.findByRole("heading", { name: "天亮了" });
    // 夜晚反馈不公开凶手
    await expect(screen.queryByText("刀了", { exact: false })).toBeNull();
  },
};

export const FeedbackBlankGuess: Story = {
  name: "阶段反馈 · 白板猜词结果",
  beforeEach: () =>
    presetWifRoom(wifFeedbackSnapshot("blankGuess"), wifPrivate("host", "blankReview")),
  play: async () => {
    await screen.findByText("猜中");
    await screen.findByRole("button", { name: "查看结算" });
  },
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
  beforeEach: () => {
    const { snapshot, privateState } = wifEndingScenario("undercover", peach);
    presetWifRoom(snapshot, privateState);
  },
};

export const GameOverGoodWin: Story = {
  name: "游戏结束 · 好人胜",
  beforeEach: () => {
    const { snapshot, privateState } = wifEndingScenario("good", me);
    presetWifRoom(snapshot, privateState);
  },
};

// ==================== 测试房间 ====================

export const TestRoom: Story = {
  name: "测试房间 · 阶段控制器",
  parameters: { router: WIF_TEST_ROUTER },
  beforeEach: () => {
    const snapshot = wifSnapshot("day2", {
      roomId: ROOM_ID_TEST_MODE,
      name: "测试房间",
      testMode: true,
    });
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

// ==================== 掉线待决 ====================

/** 投票中有玩家掉线：待决块挂在阶段之上，主持人选择等待或淘汰。 */
export const DisconnectPendingHost: Story = {
  name: "投票阶段 · 主持人 · 掉线待决",
  beforeEach: () => {
    const snapshot = wifSnapshot("vote3");
    snapshot.status.pendingDisconnectPlayerId = kanade.id;
    snapshot.players = snapshot.players.map((player) =>
      player.id === kanade.id ? { ...player, online: false } : player
    );
    presetWifRoom(snapshot, asHost);
  },
};

export const DisconnectPendingPlayer: Story = {
  name: "夜晚阶段 · 玩家 · 掉线待决",
  globals: MOBILE,
  tags: ["mobile"],
  beforeEach: () => {
    const snapshot = wifSnapshot("night2");
    snapshot.status.pendingDisconnectPlayerId = kanade.id;
    snapshot.players = snapshot.players.map((player) =>
      player.id === kanade.id ? { ...player, online: false } : player
    );
    presetWifRoom(snapshot, wifPrivate("me", "night2"));
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

// ==================== 折叠区与结算下半页（视觉审查补齐） ====================

/** 出题人关掉随机分配：手动身份表从开关下方展开，表头逐项核对数量，数量与房间配置不符时提交钮禁用并给出原因。 */
export const SubmittingWordsManualRoles: Story = {
  name: "出题阶段 · 主持人 · 手动分配身份",
  beforeEach: () => presetWifRoom(wifSnapshot("words"), wifPrivate("host", "words")),
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click(await canvas.findByRole("switch", { name: "随机分配身份" }));
    await canvas.findAllByRole("radiogroup", { name: /分配身份/ });
    dropFocus();
  },
};

/** 主持人在投票阶段打开「请求补充发言」：选人面板是按钮行上方的整宽凹块，已选两人。 */
export const VotingHostSupplementPanel: Story = {
  name: "投票阶段 · 主持人 · 选择补充发言",
  beforeEach: () => presetWifRoom(wifSnapshot("vote3"), asHost),
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click(await canvas.findByRole("button", { name: "请求补充发言" }));
    const title = await canvas.findByRole("heading", { name: "选择补充发言玩家" });
    const panel = within(title.closest<HTMLElement>(".bg-muted")!);
    for (const name of [kanade.name, kita.name])
      await userEvent.click(panel.getByRole("button", { name }));
    await canvas.findByRole("button", { name: /发起补充 \(2\)/ });
    dropFocus();
  },
};

/** 房主打开私密房间：密码框作为从属字段从开关下方展开（与 CEE、猜歌同一写法）。 */
export const SettingsPanelPrivate: Story = {
  name: "设置面板 · 房主 · 私密房间",
  beforeEach: () =>
    presetWifRoom(
      wifSnapshot("waiting", { players: readyPlayers() }),
      wifPrivate("host", "waiting")
    ),
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click(canvas.getByRole("button", { name: "房间设置" }));
    await userEvent.click(await canvas.findByRole("switch", { name: "私密房间" }));
    const password = await canvas.findByLabelText("房间密码");
    password.scrollIntoView({ block: "center" });
    dropFocus();
  },
};

/** 结算页下半段：词语解密、得分表之后的「全局历史」折叠区（视口默认只截到得分表）。 */
export const GameOverHistory: Story = {
  name: "游戏结束 · 全局历史",
  beforeEach: () => presetWifRoom(wifSnapshot("over"), wifPrivate("host", "over")),
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const header = await canvas.findByRole("button", { name: "全局历史" });
    header.scrollIntoView({ block: "start" });
    dropFocus();
  },
};
