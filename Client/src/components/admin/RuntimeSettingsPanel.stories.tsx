import type { Meta, StoryObj } from "@storybook/react-vite";
import { screen, within } from "storybook/test";
import { dropFocus } from "@/stories/PlayHelpers";
import { ADMIN_SETTINGS, adminPanelFrame, installAdmin } from "@/stories/fixtures/Admin";
import { RuntimeSettingsPanel } from "./RuntimeSettingsPanel";

/** 运行期旋钮：表格（取值来源、库值失效）与修改弹窗（版本号输入、开关），改动即生效。 */
const meta = {
  title: "Admin/RuntimeSettingsPanel",
  component: RuntimeSettingsPanel,
  tags: ["overlay"],
  decorators: [adminPanelFrame],
} satisfies Meta<typeof RuntimeSettingsPanel>;

export default meta;
type Story = StoryObj<typeof meta>;

const ready = () => screen.findByText(ADMIN_SETTINGS[0].title);
const edit = async (userEvent: { click: (element: Element) => Promise<void> }, index: number) => {
  await ready();
  await userEvent.click(screen.getAllByRole("button", { name: "修改" })[index]);
  return within(await screen.findByRole("dialog"));
};

export const WithData: Story = {
  name: "有数据",
  beforeEach: () => installAdmin(),
  play: async () => {
    await ready();
  },
};

export const EditVersion: Story = {
  name: "修改 · 版本号",
  beforeEach: () => installAdmin(),
  play: async ({ userEvent }) => {
    await edit(userEvent, 0);
    dropFocus();
  },
};

/** 模式开关保存中：保存钮转圈，弹窗不能关。 */
export const EditSwitchSaving: Story = {
  name: "修改 · 开关保存中",
  beforeEach: () => installAdmin({ "admin/settings/set": "pending" }),
  play: async ({ userEvent }) => {
    const dialog = await edit(userEvent, 3);
    await userEvent.click(dialog.getByRole("switch"));
    await userEvent.click(dialog.getByRole("button", { name: "保存" }));
    dropFocus();
  },
};

export const EditFailed: Story = {
  name: "修改 · 保存失败",
  beforeEach: () => installAdmin({ "admin/settings/set": "error" }),
  play: async ({ userEvent }) => {
    const dialog = await edit(userEvent, 0);
    await userEvent.click(dialog.getByRole("button", { name: "保存" }));
    await dialog.findByRole("alert");
    dropFocus();
  },
};

export const Empty: Story = {
  name: "没有配置项",
  beforeEach: () => installAdmin({ "admin/settings/list": { items: [] } }),
  play: async () => {
    await screen.findByText("没有可运行期调整的配置项");
  },
};

export const Loading: Story = {
  name: "加载中",
  beforeEach: () => installAdmin({ "admin/settings/list": "pending" }),
};

export const Failed: Story = {
  name: "读取失败",
  beforeEach: () => installAdmin({ "admin/settings/list": "error" }),
  play: async () => {
    await screen.findByText("运行期设置加载失败");
  },
};
