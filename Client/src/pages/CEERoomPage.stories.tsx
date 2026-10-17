import type { Meta, StoryObj } from "@storybook/react-vite";
import { screen, userEvent, waitFor, within } from "storybook/test";
import CEERoomPage from "./CEERoomPage";
import { presetCEE } from "@/stories/StorePresets";
import { useCEEStore } from "@/stores/UseCEEStore";
import {
  CEE_CHARACTERS, CEE_CUSTOM_SETTINGS, CEE_LOBBY_ROOMS, CEE_NATIVE_ROOM_ID, CEE_ORIGINAL_ROOM_ID, CEE_SESSION_TOKEN, ceeAnsweringRoom, ceeChoosingSetterRoom, ceeGuessingRoom,
  ceeOriginalRoom, ceePreparingRoom, ceeSettledRoom, ceeSyncWaitingRoom, ceeTeamGuessingRoom, ceeWaitingGuestRoom, ceeWaitingHostRoom,
  presetSavedUsername, type CEERoomScenario,
} from "@/stories/fixtures/CEE";
import { removeCEESession } from "@/lib/CEESession";

/**
 * 视作已在房间内：连接与大厅订阅就绪，且 Store 的房号和快照与路由一致，
 * useCEERoomLifecycle 因此直接复用现有房态，不发重连或加入命令。
 */
function inRoom({ snapshot, privateState }: CEERoomScenario) {
  presetCEE({
    connected: true, lobbyReady: true, originalAvailable: true,
    source: snapshot.source, roomId: snapshot.roomId, sessionToken: CEE_SESSION_TOKEN, snapshot, privateState,
  });
}

/** 追加作品按编号补名字：故事里替换 `cee.subject.lookup` 的应答，其余命令照常（不会发出）。 */
const SUBJECT_NAMES: Record<number, string> = { 328609: "孤独摇滚！", 1424: "轻音少女" };
function stubSubjectLookup() {
  const sendCommand = useCEEStore.getState().sendCommand;
  useCEEStore.setState({
    sendCommand: ((command, payload) => command === "cee.subject.lookup"
      ? Promise.resolve({ results: (payload as { subjectIds: number[] }).subjectIds.map((id) => ({ id, name: SUBJECT_NAMES[id] ?? `#${id}`, nameCn: SUBJECT_NAMES[id] ?? "", type: 2, year: null, rating: 0, heat: 0 })) })
      : sendCommand(command, payload)) as typeof sendCommand,
  });
}

/** 模拟点击会让浏览器按键盘操作绘制焦点环，真实鼠标点击没有；交互结束后移开焦点，画面与鼠标操作一致。 */
function dropFocus() {
  if (document.activeElement instanceof HTMLElement) document.activeElement.blur();
}

/**
 * 反馈表的角色图片是懒加载，离视口过远时浏览器不会开始加载，截图脚本等待图片解码会一直挂起。
 * 逐张滚到可见处等它加载完，再把游戏区滚回顶部，截图仍是刚进入页面时的画面。
 * 未渲染的图片（窄屏反馈表收起的头像）永远不会开始加载，直接跳过。
 */
async function loadLazyImages(canvasElement: HTMLElement) {
  const main = canvasElement.querySelector("main");
  if (!main) return;
  for (const image of main.querySelectorAll("img")) {
    if (image.complete || !image.getClientRects().length) continue;
    image.scrollIntoView({ block: "center" });
    await waitFor(() => { if (!image.complete) throw new Error("图片尚未加载"); });
  }
  main.scrollTop = 0;
}

const meta = {
  title: "页面/CEE房间",
  component: CEERoomPage,
  tags: ["page"],
  parameters: {
    layout: "fullscreen",
    router: { route: `/cee/room/${CEE_NATIVE_ROOM_ID}`, path: "/cee/room/:roomId" },
  },
} satisfies Meta<typeof CEERoomPage>;

export default meta;
type Story = StoryObj<typeof meta>;

export const WaitingHost: Story = {
  name: "等待阶段 · 房主",
  beforeEach: () => inRoom(ceeWaitingHostRoom()),
};

export const WaitingGuest: Story = {
  name: "等待阶段 · 玩家",
  beforeEach: () => inRoom(ceeWaitingGuestRoom()),
};

/** 设置改为等待页内的折叠面板，逐个展开以便同屏审查三组设置。 */
export const SettingsPanels: Story = {
  name: "设置面板 · 房主",
  beforeEach: () => { inRoom(ceeWaitingHostRoom(CEE_CUSTOM_SETTINGS)); stubSubjectLookup(); },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    for (const name of [/题目设置/, /猜测设置/, /房间设置/]) {
      await userEvent.click(canvas.getByRole("button", { name }));
    }
    dropFocus();
  },
};

export const ChoosingSetterHost: Story = {
  name: "指定出题人 · 房主",
  beforeEach: () => inRoom(ceeChoosingSetterRoom("host")),
};

export const ChoosingSetterGuest: Story = {
  name: "指定出题人 · 玩家",
  beforeEach: () => inRoom(ceeChoosingSetterRoom("guest")),
};

/** 非房主展开两组玩法设置：同一份结构，字段只显示取值，房主工具（预设、导入导出、目录同步）不出现。 */
export const SettingsPanelsGuest: Story = {
  name: "设置面板 · 玩家 · 只读",
  beforeEach: () => {
    const scenario = ceeWaitingGuestRoom();
    inRoom({ ...scenario, snapshot: { ...scenario.snapshot, settings: CEE_CUSTOM_SETTINGS } });
    stubSubjectLookup();
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    for (const name of ["题目设置", "猜测设置"]) await userEvent.click(canvas.getByRole("button", { name }));
    dropFocus();
  },
};

export const Preparing: Story = {
  name: "准备题目 · 房主",
  beforeEach: () => inRoom(ceePreparingRoom()),
};

export const AnsweringSetter: Story = {
  name: "出题阶段 · 出题人",
  beforeEach: () => inRoom(ceeAnsweringRoom("setter")),
};

export const AnsweringGuesser: Story = {
  name: "出题阶段 · 等待出题",
  beforeEach: () => inRoom(ceeAnsweringRoom("guesser")),
};

export const GuessingPlayer: Story = {
  name: "猜测阶段 · 玩家",
  beforeEach: () => inRoom(ceeGuessingRoom("player")),
};

/** 玩家栏按队伍分块，队伍标题给合计分与共享次数、进度。 */
export const GuessingTeams: Story = {
  name: "猜测阶段 · 组队",
  beforeEach: () => inRoom(ceeTeamGuessingRoom()),
};

/** 搜索结果浮在反馈表之上；两个已猜过的角色在全局去重下标为「已被选择」。 */
export const GuessingSearch: Story = {
  name: "猜测阶段 · 搜索结果",
  beforeEach: () => {
    const scenario = ceeGuessingRoom("player");
    inRoom({ ...scenario, privateState: { ...scenario.privateState, bannedCharacterIds: [CEE_CHARACTERS.nijika.id] } });
    const { nijika, hitori, ryo, ikuyo, kikuri } = CEE_CHARACTERS;
    useCEEStore.setState({
      searchCharacters: async () => [hitori, nijika, ryo, ikuyo, kikuri].map(({ id, name, nameCn, imageUrl }) => ({ id, name, nameCn, imageUrl })),
    });
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.type(canvas.getByRole("combobox", { name: "搜索角色" }), "结束乐队");
    await userEvent.click(canvas.getByRole("button", { name: "搜角色" }));
    await screen.findByRole("listbox", { name: "搜索角色结果" });
  },
};

export const GuessingSpectator: Story = {
  name: "猜测阶段 · 旁观",
  beforeEach: () => inRoom(ceeGuessingRoom("spectator")),
  play: ({ canvasElement }) => loadLazyImages(canvasElement),
};

/** 出题人从搜索结果选中答案：「已选择」与搜索结果同一款行，行尾可清除。 */
export const AnsweringSelected: Story = {
  name: "出题阶段 · 已选答案",
  beforeEach: () => {
    inRoom(ceeAnsweringRoom("setter"));
    const { nijika, hitori } = CEE_CHARACTERS;
    useCEEStore.setState({ searchCharacters: async () => [nijika, hitori].map(({ id, name, nameCn, imageUrl }) => ({ id, name, nameCn, imageUrl })) });
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.type(canvas.getByRole("combobox", { name: "搜索角色" }), "虹夏");
    await userEvent.click(canvas.getByRole("button", { name: "搜角色" }));
    const listbox = await screen.findByRole("listbox", { name: "搜索角色结果" });
    await userEvent.click(within(listbox).getAllByRole("option")[0]);
    await canvas.findByRole("button", { name: "清除已选答案" });
    dropFocus();
  },
};

/** 点开图片提示：占位格展开，图片落在固定高度的格里，级数写在按钮旁。 */
export const GuessingImageHint: Story = {
  name: "猜测阶段 · 图片提示",
  beforeEach: () => {
    inRoom(ceeGuessingRoom("player"));
    const sendCommand = useCEEStore.getState().sendCommand;
    useCEEStore.setState({
      sendCommand: ((command, payload) => command === "cee.game.imageHint"
        ? Promise.resolve({ dataUrl: CEE_CHARACTERS.nijika.imageUrl })
        : sendCommand(command, payload)) as typeof sendCommand,
    });
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click(canvas.getByRole("button", { name: "查看图片提示" }));
    await canvas.findByRole("img", { name: "第 6 级图片提示" });
    dropFocus();
  },
};

export const SyncWaiting: Story = {
  name: "同步模式 · 等待其他玩家",
  beforeEach: () => inRoom(ceeSyncWaitingRoom()),
};

export const Settled: Story = {
  name: "结算 · 房主",
  beforeEach: () => inRoom(ceeSettledRoom()),
  play: ({ canvasElement }) => loadLazyImages(canvasElement),
};

export const OriginalReconnecting: Story = {
  name: "原版房 · 原版重连中",
  parameters: { router: { route: `/cee/room/${CEE_ORIGINAL_ROOM_ID}` } },
  beforeEach: () => inRoom(ceeOriginalRoom()),
};

export const Connecting: Story = {
  name: "连接中",
  // Store 初始状态即未连接：生命周期等待连接，进房门显示加入中。
  beforeEach: () => presetCEE(),
};

/** 直链进房自动加入：不再有「设置用户名」步，无凭据时直接显示加入中。 */
export const JoinDialog: Story = {
  name: "加入房间中",
  tags: ["!page", "overlay"],
  beforeEach: () => {
    // 没有本房凭据也没有快照：页面生命周期自动用本地用户名（或访客名）加入。
    removeCEESession(CEE_NATIVE_ROOM_ID);
    presetCEE({ connected: true, lobbyReady: true, originalAvailable: true });
    return presetSavedUsername();
  },
  play: async () => {
    await screen.findByText("正在加入房间...");
  },
};

/** 私密房：直链自动加入被服务端要求密码，直接落到输入密码步；是否私密取自大厅列表。 */
export const JoinPassword: Story = {
  name: "加入房间弹窗 · 输入密码",
  tags: ["!page", "overlay"],
  beforeEach: () => {
    removeCEESession(CEE_NATIVE_ROOM_ID);
    presetCEE({
      connected: true, lobbyReady: true, originalAvailable: true,
      rooms: CEE_LOBBY_ROOMS.map((room) => room.roomId === CEE_NATIVE_ROOM_ID ? { ...room, hasPassword: true } : room),
    });
    // eslint-disable-next-line @typescript-eslint/prefer-promise-reject-errors -- 协议错误体是数据契约：页面按 code 决定弹密码框还是报「密码错误」
    useCEEStore.setState({ joinRoom: () => Promise.reject({ code: "PASSWORD_REQUIRED", message: "该房间需要密码" }) });
    return presetSavedUsername();
  },
  play: async () => {
    await screen.findByRole("dialog", { name: "输入房间密码" });
  },
};

/** 密码错误写在密码框下并标红，不再另弹提示条；错误码来自服务端应答。 */
export const JoinPasswordWrong: Story = {
  name: "加入房间弹窗 · 密码错误",
  tags: ["!page", "overlay"],
  beforeEach: () => {
    removeCEESession(CEE_NATIVE_ROOM_ID);
    presetCEE({
      connected: true, lobbyReady: true, originalAvailable: true,
      rooms: CEE_LOBBY_ROOMS.map((room) => room.roomId === CEE_NATIVE_ROOM_ID ? { ...room, hasPassword: true } : room),
    });
    // eslint-disable-next-line @typescript-eslint/prefer-promise-reject-errors -- 协议错误体是数据契约：页面按 code 决定弹密码框还是报「密码错误」
    useCEEStore.setState({ joinRoom: () => Promise.reject({ code: "PASSWORD_INCORRECT", message: "房间密码错误" }) });
    return presetSavedUsername();
  },
  play: async () => {
    const dialog = within(await screen.findByRole("dialog", { name: "输入房间密码" }));
    await userEvent.type(dialog.getByLabelText("房间密码"), "1234");
    await userEvent.click(dialog.getByRole("button", { name: "加入房间" }));
    await dialog.findByText("房间密码错误");
    dropFocus();
  },
};

export const MobilePlayers: Story = {
  name: "手机 · 玩家面板",
  tags: ["mobile"],
  globals: { viewport: { value: "mobile", isRotated: false } },
  beforeEach: () => inRoom(ceeGuessingRoom("player")),
  play: async ({ canvasElement }) => {
    await userEvent.click(within(canvasElement).getByRole("button", { name: "玩家列表" }));
    // 抽屉的可访问名称取自标题：Radix 的 aria-labelledby 决定面板名。
    await screen.findByRole("dialog", { name: "玩家" });
    dropFocus();
  },
};

export const MobileChat: Story = {
  name: "手机 · 聊天面板",
  tags: ["mobile"],
  globals: { viewport: { value: "mobile", isRotated: false } },
  beforeEach: () => inRoom(ceeGuessingRoom("player")),
  play: async ({ canvasElement }) => {
    await userEvent.click(within(canvasElement).getByRole("button", { name: "聊天" }));
    await screen.findByRole("dialog", { name: "聊天" });
    dropFocus();
  },
};
