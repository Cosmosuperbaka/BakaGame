import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect, screen, userEvent, waitFor, within } from "storybook/test";
import { sonGuessrWsClient } from "@/lib/SonGuessrWs";
import { fromNow } from "@/stories/fixtures/Common";
import { dropFocus } from "@/stories/PlayHelpers";
import {
  animeRoundSummary,
  choosingSnapshot,
  guesserPrivate,
  playingSnapshot,
  presetSongRoom,
  roundResultSnapshot,
  seedSoloRoom,
  seedUsername,
  soloPlayingSnapshot,
  soloResultSnapshot,
  soloSnapshot,
  SONG_PEOPLE,
  SONG_ROOM_ROUTER,
  SONG_SEARCH_RESULTS,
  SONG_SOLO_ROUTER,
  songPlayer,
  songPrivate,
  songSettings,
  songSnapshot,
  spectatorPrivate,
  stubSongActions,
  submitterPrivate,
  submittingSnapshot,
  waitForLyrics,
  waitingPlayers,
} from "@/stories/fixtures/SonGuessr";
import SonGuessrRoomPage from "./SonGuessrRoomPage";
import { rejectedProtocol } from "@/lib/ProtocolFailure";

const { host, me, peach } = SONG_PEOPLE;

const meta = {
  title: "页面/猜歌房间",
  component: SonGuessrRoomPage,
  tags: ["page"],
  parameters: { layout: "fullscreen", router: SONG_ROOM_ROUTER },
} satisfies Meta<typeof SonGuessrRoomPage>;

export default meta;
type Story = StoryObj<typeof meta>;

const MOBILE = { viewport: { value: "mobile", isRotated: false } };

/** 让入房流程越过“等待连接”：只替换连接就绪检查，不建立任何 WebSocket。 */
function connectInstantly() {
  Object.defineProperty(sonGuessrWsClient, "waitForConnection", {
    configurable: true,
    value: () => Promise.resolve(),
  });
  return () => {
    Reflect.deleteProperty(sonGuessrWsClient, "waitForConnection");
  };
}

const allReady = () =>
  waitingPlayers().map((player) =>
    player.membership === "active" ? { ...player, isReady: true } : player
  );
const asHost = songPrivate({ playerId: host.id });

// ==================== 入房 ====================

/** 未入房且连接尚未就绪：停在加载指示（8 秒连接超时后会返回大厅）。 */
export const Joining: Story = { name: "正在加入房间" };

export const NameDialog: Story = {
  name: "设置用户名",
  tags: ["!page", "overlay"],
  beforeEach: () => {
    const restoreName = seedUsername("");
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

export const PasswordDialog: Story = {
  name: "输入房间密码",
  tags: ["!page", "overlay"],
  beforeEach: () => {
    const restoreName = seedUsername(me.name);
    const restoreConnection = connectInstantly();
    stubSongActions({
      joinRoom: () => rejectedProtocol({ code: "PASSWORD_REQUIRED", message: "该房间需要密码" }),
    });
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
    const restoreName = seedUsername(me.name);
    const restoreConnection = connectInstantly();
    stubSongActions({
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
    const restoreName = seedUsername(me.name);
    const restoreConnection = connectInstantly();
    stubSongActions({
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
    const restoreName = seedUsername(me.name);
    const restoreConnection = connectInstantly();
    stubSongActions({ joinRoom: lockedJoin(["pending"]) });
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

/** 等待页的开局按钮在设置组之下，桌面视口也看不到：滚到按钮露出，故事所说的状态才进得了截图。 */
async function revealStartButton(canvasElement: HTMLElement, name: string) {
  const button = await within(canvasElement).findByRole("button", { name });
  button.scrollIntoView({ block: "end" });
}

export const WaitingHostLoggedOut: Story = {
  name: "等待阶段 · 房主 · 未登录网易云",
  beforeEach: () =>
    presetSongRoom(songSnapshot({ musicAccountReady: false, players: allReady() }), asHost),
  // 两条故事的差别只在页底的开局按钮：不滚到它，截图与「可以开始」逐像素相同。
  play: async ({ canvasElement }) =>
    revealStartButton(canvasElement, "请先登录网易云或 QQ 音乐账号"),
};

export const WaitingHostReady: Story = {
  name: "等待阶段 · 房主 · 可以开始",
  beforeEach: () => presetSongRoom(songSnapshot({ players: allReady() }), asHost),
  play: async ({ canvasElement }) => revealStartButton(canvasElement, "开始游戏"),
};

export const WaitingHostNotReady: Story = {
  name: "等待阶段 · 房主 · 等待准备",
  beforeEach: () => presetSongRoom(songSnapshot(), asHost),
};

export const WaitingPlayer: Story = {
  name: "等待阶段 · 玩家",
  beforeEach: () =>
    presetSongRoom(
      songSnapshot({
        players: waitingPlayers().map((player) => (player.id === me.id ? songPlayer(me) : player)),
      }),
      songPrivate()
    ),
};

export const WaitingPlayerReady: Story = {
  name: "等待阶段 · 玩家 · 已准备",
  beforeEach: () => presetSongRoom(songSnapshot(), songPrivate()),
};

export const WaitingSpectator: Story = {
  name: "等待阶段 · 旁观",
  beforeEach: () =>
    presetSongRoom(
      songSnapshot(),
      spectatorPrivate({ submittedSong: undefined, visibleAttempts: [] })
    ),
};

export const SettingsPanels: Story = {
  name: "设置面板 · 房主",
  beforeEach: () =>
    presetSongRoom(
      songSnapshot({
        players: allReady(),
        settings: songSettings({ spectatorsSeeAnswers: true }),
      }),
      asHost
    ),
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    for (const name of [/题目设置/, /猜测设置/, /房间设置/]) {
      await userEvent.click(canvas.getByRole("button", { name }));
    }
    dropFocus();
  },
};

/** 非房主展开题目、猜测与房间设置：同一份结构，字段只显示取值。 */
export const SettingsPanelsGuest: Story = {
  name: "设置面板 · 玩家 · 只读",
  beforeEach: () => presetSongRoom(songSnapshot({ players: allReady() }), songPrivate()),
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    for (const name of ["题目设置", "猜测设置", "房间设置"])
      await userEvent.click(canvas.getByRole("button", { name }));
    dropFocus();
  },
};

// ==================== 指定出题人与出题 ====================

export const ChoosingHost: Story = {
  name: "指定出题人 · 房主",
  beforeEach: () => presetSongRoom(choosingSnapshot(), asHost),
};

export const ChoosingPlayer: Story = {
  name: "指定出题人 · 玩家",
  beforeEach: () => presetSongRoom(choosingSnapshot(), songPrivate()),
};

export const SubmittingSubmitter: Story = {
  name: "出题阶段 · 出题人",
  beforeEach: () =>
    presetSongRoom(
      submittingSnapshot(),
      songPrivate({ playerId: peach.id, isSubmitter: true, canSubmitSong: true })
    ),
};

export const SubmittingSearch: Story = {
  name: "出题阶段 · 出题人 · 搜索歌曲",
  beforeEach: () => {
    presetSongRoom(
      submittingSnapshot(),
      songPrivate({ playerId: peach.id, isSubmitter: true, canSubmitSong: true })
    );
    stubSongActions({ searchMusic: () => Promise.resolve(SONG_SEARCH_RESULTS) });
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.type(canvas.getByRole("combobox", { name: "搜索歌曲" }), "夜行ラジオ");
    await screen.findByRole("listbox", { name: "搜索歌曲结果" });
  },
};

export const SubmittingOthers: Story = {
  name: "出题阶段 · 其他玩家",
  beforeEach: () => presetSongRoom(submittingSnapshot(), songPrivate()),
};

// ==================== 猜歌阶段 ====================

export const PlayingGuesser: Story = {
  name: "猜歌阶段 · 猜歌玩家",
  beforeEach: () => presetSongRoom(playingSnapshot(), guesserPrivate(fromNow(47_000))),
  play: async ({ canvasElement }) => waitForLyrics(canvasElement),
};

export const PlayingSubmitter: Story = {
  name: "猜歌阶段 · 出题人",
  beforeEach: () => presetSongRoom(playingSnapshot(), submitterPrivate()),
  play: async ({ canvasElement }) => waitForLyrics(canvasElement),
};

export const PlayingSpectator: Story = {
  name: "猜歌阶段 · 旁观",
  beforeEach: () => presetSongRoom(playingSnapshot(), spectatorPrivate()),
  play: async ({ canvasElement }) => waitForLyrics(canvasElement),
};

// ==================== 结算 ====================

export const RoundResultHost: Story = {
  name: "答案揭晓 · 房主",
  beforeEach: () => presetSongRoom(roundResultSnapshot(), asHost),
};

export const RoundResultPlayer: Story = {
  name: "答案揭晓 · 玩家",
  beforeEach: () => presetSongRoom(roundResultSnapshot(), songPrivate()),
};

export const RoundResultAnime: Story = {
  name: "答案揭晓 · 听歌猜番 · 玩家",
  beforeEach: () =>
    presetSongRoom(
      roundResultSnapshot({
        settings: songSettings({ questionType: "anime" }),
        roundSummary: animeRoundSummary(),
      }),
      songPrivate()
    ),
};

// ==================== 单人模式 ====================

const soloPrivate = songPrivate({ playerId: me.id });

export const SoloWaiting: Story = {
  name: "单人模式 · 准备开始",
  args: { solo: true },
  parameters: { router: SONG_SOLO_ROUTER },
  beforeEach: () => {
    presetSongRoom(soloSnapshot(), soloPrivate);
    return seedSoloRoom();
  },
};

export const SoloPlaying: Story = {
  name: "单人模式 · 猜歌",
  args: { solo: true },
  parameters: { router: SONG_SOLO_ROUTER },
  beforeEach: () => {
    presetSongRoom(
      soloPlayingSnapshot(),
      guesserPrivate(fromNow(52_000), { remainingGuesses: 3, visibleAttempts: [] })
    );
    return seedSoloRoom();
  },
  play: async ({ canvasElement }) => waitForLyrics(canvasElement),
};

export const SoloResult: Story = {
  name: "单人模式 · 答案揭晓",
  args: { solo: true },
  parameters: { router: SONG_SOLO_ROUTER },
  beforeEach: () => {
    presetSongRoom(soloResultSnapshot(), soloPrivate);
    return seedSoloRoom();
  },
};

// ==================== 移动端覆盖面板 ====================

/** 手机上歌词卡占满首屏：猜测栏贴在游戏区底边，不用先滚下去才能作答。 */
export const MobileGuessBar: Story = {
  name: "移动端 · 猜测栏贴底",
  tags: ["mobile"],
  globals: MOBILE,
  beforeEach: () =>
    presetSongRoom(
      playingSnapshot({ settings: songSettings({ questionMode: "automatic" }) }),
      guesserPrivate(fromNow(47_000))
    ),
  play: async ({ canvasElement }) => waitForLyrics(canvasElement),
};

export const MobilePlayers: Story = {
  name: "移动端 · 玩家列表",
  tags: ["mobile"],
  globals: MOBILE,
  beforeEach: () => presetSongRoom(playingSnapshot(), guesserPrivate(fromNow(47_000))),
  play: async ({ canvasElement }) => {
    await waitForLyrics(canvasElement);
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
  beforeEach: () => presetSongRoom(playingSnapshot(), guesserPrivate(fromNow(47_000))),
  play: async ({ canvasElement }) => {
    await waitForLyrics(canvasElement);
    const toggle = within(canvasElement).getByRole("button", { name: "聊天" });
    await userEvent.click(toggle);
    await waitFor(() => expect(toggle).toHaveAttribute("aria-expanded", "true"));
    dropFocus();
  },
};
