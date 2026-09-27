import type { Meta, StoryObj } from "@storybook/react-vite";
import { screen, userEvent, waitFor, within } from "storybook/test";
import CCBRoomPage from "./CCBRoomPage";
import { presetCCB } from "@/stories/StorePresets";
import {
  CCB_CUSTOM_SETTINGS, CCB_NATIVE_ROOM_ID, CCB_ORIGINAL_ROOM_ID, CCB_SESSION_TOKEN, ccbAnsweringRoom, ccbGuessingRoom,
  ccbOriginalRoom, ccbPreparingRoom, ccbSettledRoom, ccbSyncWaitingRoom, ccbWaitingGuestRoom, ccbWaitingHostRoom,
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

/** 模拟点击会让浏览器按键盘操作绘制焦点环，真实鼠标点击没有；交互结束后移开焦点，画面与鼠标操作一致。 */
function dropFocus() {
  if (document.activeElement instanceof HTMLElement) document.activeElement.blur();
}

/**
 * 反馈表的角色图片是懒加载，离视口过远时浏览器不会开始加载，截图脚本等待图片解码会一直挂起。
 * 逐张滚到可见处等它加载完，再把游戏区滚回顶部，截图仍是刚进入页面时的画面。
 */
async function loadLazyImages(canvasElement: HTMLElement) {
  const main = canvasElement.querySelector("main");
  if (!main) return;
  for (const image of main.querySelectorAll("img")) {
    if (image.complete) continue;
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

export const SettingsDialog: Story = {
  name: "题目设置弹窗 · 房主",
  tags: ["!page", "overlay"],
  beforeEach: () => inRoom(ccbWaitingHostRoom(CCB_CUSTOM_SETTINGS)),
  play: async ({ canvasElement }) => {
    await userEvent.click(within(canvasElement).getByRole("button", { name: "题目设置" }));
    await screen.findByRole("dialog", { name: "题目设置" });
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

export const GuessingSpectator: Story = {
  name: "猜测阶段 · 旁观",
  beforeEach: () => inRoom(ccbGuessingRoom("spectator")),
  play: ({ canvasElement }) => loadLazyImages(canvasElement),
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
  name: "连接中 · 重连中",
  // Store 初始状态即未连接：生命周期等待连接，页面显示连接提示，顶栏显示重连中。
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
    await screen.findByRole("dialog", { name: `加入房间 #${CCB_NATIVE_ROOM_ID}` });
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
