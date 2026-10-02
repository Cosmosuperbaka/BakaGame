import type { Meta, StoryObj } from "@storybook/react-vite";
import { screen, userEvent, within } from "storybook/test";
import CCBPage from "./CCBPage";
import { presetCCB } from "@/stories/StorePresets";
import { CCB_LOBBY_ROOMS, presetSavedUsername } from "@/stories/fixtures/CCB";

/** 已连上 CCB 服务并完成大厅订阅，原版服务器可用。 */
const lobby = (patch: Parameters<typeof presetCCB>[0] = {}) =>
  presetCCB({ connected: true, lobbyReady: true, originalAvailable: true, ...patch });

/** 模拟点击会让浏览器按键盘操作绘制焦点环，真实鼠标点击没有；交互结束后移开焦点，画面与鼠标操作一致。 */
function dropFocus() {
  if (document.activeElement instanceof HTMLElement) document.activeElement.blur();
}

const meta = {
  title: "页面/CCB大厅",
  component: CCBPage,
  tags: ["page"],
  parameters: { layout: "fullscreen", router: { route: "/ccb" } },
  beforeEach: () => presetSavedUsername(),
} satisfies Meta<typeof CCBPage>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Loading: Story = {
  name: "加载中",
  beforeEach: () => presetCCB({ connected: true }),
};

/** 增强房与原版公开房合并成一个列表，原版房带来源徽章。 */
export const Rooms: Story = {
  name: "房间列表",
  beforeEach: () => lobby({ rooms: CCB_LOBBY_ROOMS }),
};

export const Empty: Story = {
  name: "暂无房间",
  beforeEach: () => lobby(),
};

export const OriginalUnavailable: Story = {
  name: "原版服务器未接入 · 建房弹窗",
  tags: ["!page", "overlay"],
  beforeEach: () => lobby({ originalAvailable: false, rooms: CCB_LOBBY_ROOMS.filter((room) => room.source === "native") }),
  play: async ({ canvasElement }) => {
    await userEvent.click(within(canvasElement).getByRole("button", { name: "创建房间" }));
    const dialog = within(await screen.findByRole("dialog", { name: "创建房间" }));
    await dialog.findByText("原版服务器暂未接入，请使用增强房。");
    dropFocus();
  },
};

export const CreateDialog: Story = {
  name: "创建增强房弹窗 · 私密房间",
  tags: ["!page", "overlay"],
  beforeEach: () => lobby({ rooms: CCB_LOBBY_ROOMS }),
  play: async ({ canvasElement }) => {
    await userEvent.click(within(canvasElement).getByRole("button", { name: "创建房间" }));
    const dialog = within(await screen.findByRole("dialog", { name: "创建房间" }));
    await userEvent.click(dialog.getByRole("radio", { name: "增强房" }));
    await userEvent.click(dialog.getByRole("switch", { name: "私密房间" }));
    await dialog.findByLabelText("房间密码");
    dropFocus();
  },
};

/** 原版服务器没有密码机制：私密开关改为「不在大厅显示」并常驻说明，禁观战开关禁用并写明原因。 */
export const CreateOriginalDialog: Story = {
  name: "创建原版房弹窗 · 不在大厅显示",
  tags: ["!page", "overlay"],
  beforeEach: () => lobby({ rooms: CCB_LOBBY_ROOMS }),
  play: async ({ canvasElement }) => {
    await userEvent.click(within(canvasElement).getByRole("button", { name: "创建房间" }));
    const dialog = within(await screen.findByRole("dialog", { name: "创建房间" }));
    await userEvent.click(dialog.getByRole("radio", { name: "原版房" }));
    await userEvent.click(await dialog.findByRole("switch", { name: "不在大厅显示" }));
    dropFocus();
  },
};

export const JoinPassword: Story = {
  name: "输入房间密码",
  tags: ["!page", "overlay"],
  beforeEach: () => lobby({ rooms: CCB_LOBBY_ROOMS }),
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click(canvas.getByText("内部练习房"));
    await screen.findByRole("dialog", { name: "输入房间密码" });
    dropFocus();
  },
};
