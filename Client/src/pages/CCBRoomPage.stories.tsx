import type { Meta, StoryObj } from "@storybook/react-vite";
import { screen, userEvent, waitFor, within } from "storybook/test";
import CCBRoomPage from "./CCBRoomPage";
import { presetCCB } from "@/stories/StorePresets";
import { useCCBStore } from "@/stores/UseCCBStore";
import {
  CCB_CHARACTERS, CCB_CUSTOM_SETTINGS, CCB_LOBBY_ROOMS, CCB_NATIVE_ROOM_ID, CCB_ORIGINAL_ROOM_ID, CCB_SESSION_TOKEN, ccbAnsweringRoom, ccbChoosingSetterRoom, ccbGuessingRoom,
  ccbOriginalRoom, ccbPreparingRoom, ccbSettledRoom, ccbSyncWaitingRoom, ccbTeamGuessingRoom, ccbWaitingGuestRoom, ccbWaitingHostRoom,
  presetSavedUsername, type CCBRoomScenario,
} from "@/stories/fixtures/CCB";
import { removeCCBSession } from "@/lib/CCBSession";

/**
 * 视作已在房间内：连接与大厅订阅就绪，且 Store 的房号和快照与路由一致，
 * useCCBRoomLifecycle 因此直接复用现有房态，不发重连或加入命令。
 */
function inRoom({ snapshot, privateState }: CCBRoomScenario) {
  presetCCB({
    connected: true, lobbyReady: true, originalAvailable: true,
    source: snapshot.source, roomId: snapshot.roomId, sessionToken: CCB_SESSION_TOKEN, snapshot, privateState,
  });
}

/** 追加作品按编号补名字：故事里替换 `ccb.subject.lookup` 的应答，其余命令照常（不会发出）。 */
const SUBJECT_NAMES: Record<number, string> = { 328609: "孤独摇滚！", 1424: "轻音少女" };
function stubSubjectLookup() {
  const sendCommand = useCCBStore.getState().sendCommand;
  useCCBStore.setState({
    sendCommand: ((command, payload) => command === "ccb.subject.lookup"
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
  title: "页面/CCB房间",
  component: CCBRoomPage,
  tags: ["page"],
  parameters: {
    layout: "fullscreen",
    router: { route: `/ccb/room/${CCB_NATIVE_ROOM_ID}`, path: "/ccb/room/:roomId" },
  },
} satisfies Meta<typeof CCBRoomPage>;

export default meta;
type Story = StoryObj<typeof meta>;

export const WaitingHost: Story = {
  name: "等待阶段 · 房主",
  beforeEach: () => inRoom(ccbWaitingHostRoom()),
};

export const WaitingGuest: Story = {
  name: "等待阶段 · 玩家",
  beforeEach: () => inRoom(ccbWaitingGuestRoom()),
};

/** 设置改为等待页内的折叠面板，逐个展开以便同屏审查三组设置。 */
export const SettingsPanels: Story = {
  name: "设置面板 · 房主",
  beforeEach: () => { inRoom(ccbWaitingHostRoom(CCB_CUSTOM_SETTINGS)); stubSubjectLookup(); },
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
  beforeEach: () => inRoom(ccbChoosingSetterRoom("host")),
};

export const ChoosingSetterGuest: Story = {
  name: "指定出题人 · 玩家",
  beforeEach: () => inRoom(ccbChoosingSetterRoom("guest")),
};

/** 非房主展开两组玩法设置：同一份结构，字段只显示取值，房主工具（预设、导入导出、目录同步）不出现。 */
export const SettingsPanelsGuest: Story = {
  name: "设置面板 · 玩家 · 只读",
  beforeEach: () => {
    const scenario = ccbWaitingGuestRoom();
    inRoom({ ...scenario, snapshot: { ...scenario.snapshot, settings: CCB_CUSTOM_SETTINGS } });
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
  beforeEach: () => inRoom(ccbPreparingRoom()),
};

export const AnsweringSetter: Story = {
  name: "出题阶段 · 出题人",
  beforeEach: () => inRoom(ccbAnsweringRoom("setter")),
};

export const AnsweringGuesser: Story = {
  name: "出题阶段 · 等待出题",
  beforeEach: () => inRoom(ccbAnsweringRoom("guesser")),
};

export const GuessingPlayer: Story = {
  name: "猜测阶段 · 玩家",
  beforeEach: () => inRoom(ccbGuessingRoom("player")),
};

/** 玩家栏按队伍分块，队伍标题给合计分与共享次数、进度。 */
export const GuessingTeams: Story = {
  name: "猜测阶段 · 组队",
  beforeEach: () => inRoom(ccbTeamGuessingRoom()),
};

/** 搜索结果浮在反馈表之上；两个已猜过的角色在全局去重下标为「已被选择」。 */
export const GuessingSearch: Story = {
  name: "猜测阶段 · 搜索结果",
  beforeEach: () => {
    const scenario = ccbGuessingRoom("player");
    inRoom({ ...scenario, privateState: { ...scenario.privateState, bannedCharacterIds: [CCB_CHARACTERS.nijika.id] } });
    const { nijika, hitori, ryo, ikuyo, kikuri } = CCB_CHARACTERS;
    useCCBStore.setState({
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
  beforeEach: () => inRoom(ccbGuessingRoom("spectator")),
  play: ({ canvasElement }) => loadLazyImages(canvasElement),
};

/** 出题人从搜索结果选中答案：「已选择」与搜索结果同一款行，行尾可清除。 */
export const AnsweringSelected: Story = {
  name: "出题阶段 · 已选答案",
  beforeEach: () => {
    inRoom(ccbAnsweringRoom("setter"));
    const { nijika, hitori } = CCB_CHARACTERS;
    useCCBStore.setState({ searchCharacters: async () => [nijika, hitori].map(({ id, name, nameCn, imageUrl }) => ({ id, name, nameCn, imageUrl })) });
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
    inRoom(ccbGuessingRoom("player"));
    const sendCommand = useCCBStore.getState().sendCommand;
    useCCBStore.setState({
      sendCommand: ((command, payload) => command === "ccb.game.imageHint"
        ? Promise.resolve({ dataUrl: CCB_CHARACTERS.nijika.imageUrl })
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
  beforeEach: () => inRoom(ccbSyncWaitingRoom()),
};

export const Settled: Story = {
  name: "结算 · 房主",
  beforeEach: () => inRoom(ccbSettledRoom()),
  play: ({ canvasElement }) => loadLazyImages(canvasElement),
};

export const OriginalReconnecting: Story = {
  name: "原版房 · 原版重连中",
  parameters: { router: { route: `/ccb/room/${CCB_ORIGINAL_ROOM_ID}` } },
  beforeEach: () => inRoom(ccbOriginalRoom()),
};

export const Connecting: Story = {
  name: "连接中",
  // Store 初始状态即未连接：生命周期等待连接，进房门显示加入中。
  beforeEach: () => presetCCB(),
};

export const JoinDialog: Story = {
  name: "加入房间弹窗",
  tags: ["!page", "overlay"],
  beforeEach: () => {
    // 没有本房凭据也没有快照：页面生命周期判定需要重新加入。
    removeCCBSession(CCB_NATIVE_ROOM_ID);
    presetCCB({ connected: true, lobbyReady: true, originalAvailable: true });
    return presetSavedUsername();
  },
  play: async () => {
    await screen.findByRole("dialog", { name: "设置用户名" });
  },
};

/** 私密房分两步：填好名字后再输密码；是否私密取自大厅列表。 */
export const JoinPassword: Story = {
  name: "加入房间弹窗 · 输入密码",
  tags: ["!page", "overlay"],
  beforeEach: () => {
    removeCCBSession(CCB_NATIVE_ROOM_ID);
    presetCCB({
      connected: true, lobbyReady: true, originalAvailable: true,
      rooms: CCB_LOBBY_ROOMS.map((room) => room.roomId === CCB_NATIVE_ROOM_ID ? { ...room, hasPassword: true } : room),
    });
    return presetSavedUsername();
  },
  play: async () => {
    const dialog = await screen.findByRole("dialog", { name: "设置用户名" });
    await userEvent.click(within(dialog).getByRole("button", { name: "进入房间" }));
    await screen.findByRole("dialog", { name: "输入房间密码" });
  },
};

/** 密码错误写在密码框下并标红，不再另弹提示条；错误码来自服务端应答。 */
export const JoinPasswordWrong: Story = {
  name: "加入房间弹窗 · 密码错误",
  tags: ["!page", "overlay"],
  beforeEach: () => {
    removeCCBSession(CCB_NATIVE_ROOM_ID);
    presetCCB({
      connected: true, lobbyReady: true, originalAvailable: true,
      rooms: CCB_LOBBY_ROOMS.map((room) => room.roomId === CCB_NATIVE_ROOM_ID ? { ...room, hasPassword: true } : room),
    });
    useCCBStore.setState({ joinRoom: () => Promise.reject({ code: "PASSWORD_INCORRECT", message: "房间密码错误" }) });
    return presetSavedUsername();
  },
  play: async () => {
    const nameDialog = await screen.findByRole("dialog", { name: "设置用户名" });
    await userEvent.click(within(nameDialog).getByRole("button", { name: "进入房间" }));
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
  beforeEach: () => inRoom(ccbGuessingRoom("player")),
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
  beforeEach: () => inRoom(ccbGuessingRoom("player")),
  play: async ({ canvasElement }) => {
    await userEvent.click(within(canvasElement).getByRole("button", { name: "聊天" }));
    await screen.findByRole("dialog", { name: "聊天" });
    dropFocus();
  },
};
