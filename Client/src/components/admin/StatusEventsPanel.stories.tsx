import type { Meta, StoryObj } from "@storybook/react-vite";
import { screen, within } from "storybook/test";
import { dropFocus } from "@/stories/PlayHelpers";
import { ADMIN_STATUS_EVENTS, adminPanelFrame, installAdmin } from "@/stories/fixtures/Admin";
import { StatusEventsPanel } from "./StatusEventsPanel";

/** 状态事件：列表、筛选、分页，发布与修改表单，删除确认。 */
const meta = {
  title: "Admin/StatusEventsPanel",
  component: StatusEventsPanel,
  tags: ["overlay"],
  decorators: [adminPanelFrame],
} satisfies Meta<typeof StatusEventsPanel>;

export default meta;
type Story = StoryObj<typeof meta>;

const ready = () => screen.findByText(ADMIN_STATUS_EVENTS[1].title);

export const WithData: Story = {
  name: "有数据",
  beforeEach: () => installAdmin(),
  play: async () => {
    await ready();
  },
};

/** 末页：26 条的第 21–26 条。 */
export const LastPage: Story = {
  name: "末页",
  beforeEach: () => installAdmin(),
  play: async ({ userEvent }) => {
    await ready();
    await userEvent.click(screen.getByRole("button", { name: "下一页" }));
    await screen.findByText(ADMIN_STATUS_EVENTS[21].title);
    dropFocus();
  },
};

export const Empty: Story = {
  name: "筛选无结果",
  beforeEach: () => installAdmin({ "admin/statusEvents/list": { items: [], total: 0 } }),
  play: async ({ userEvent }) => {
    await userEvent.click(await screen.findByRole("radio", { name: "维护" }));
    await screen.findByText("没有匹配的状态事件");
    dropFocus();
  },
};

export const Loading: Story = {
  name: "加载中",
  beforeEach: () => installAdmin({ "admin/statusEvents/list": "pending" }),
};

export const Failed: Story = {
  name: "读取失败",
  beforeEach: () => installAdmin({ "admin/statusEvents/list": "error" }),
  play: async () => {
    await screen.findByText("状态事件加载失败");
  },
};

/** 发布维护窗口：结束早于开始，发布按钮禁用、结束框标红。 */
export const CreateInvalid: Story = {
  name: "发布 · 校验错误",
  beforeEach: () => installAdmin(),
  play: async ({ userEvent }) => {
    await ready();
    await userEvent.click(screen.getByRole("button", { name: "发布事件" }));
    const dialog = within(await screen.findByRole("dialog"));
    await userEvent.click(dialog.getByRole("radio", { name: "维护窗口" }));
    await userEvent.type(dialog.getByLabelText("标题"), "数据库升级");
    await userEvent.type(dialog.getByLabelText("内容"), "预计停机半小时。");
    await userEvent.click(dialog.getByRole("button", { name: "搜索索引" }));
    await userEvent.type(dialog.getByLabelText("窗口结束"), "2026-12-01T10:00");
    dropFocus();
  },
};

/** 修改进行中的事件，保存失败：失败说明留在弹窗里。 */
export const EditFailed: Story = {
  name: "修改 · 保存失败",
  beforeEach: () => installAdmin({ "admin/statusEvents/update": "error" }),
  play: async ({ userEvent }) => {
    await ready();
    await userEvent.click(screen.getAllByRole("button", { name: "修改" })[0]);
    const dialog = within(await screen.findByRole("dialog"));
    await userEvent.click(dialog.getByRole("button", { name: "保存修改" }));
    await dialog.findByRole("alert");
    dropFocus();
  },
};

export const ConfirmDelete: Story = {
  name: "删除确认",
  beforeEach: () => installAdmin(),
  play: async ({ userEvent }) => {
    await ready();
    await userEvent.click(screen.getAllByRole("button", { name: "删除" })[0]);
    await screen.findByRole("dialog");
    dropFocus();
  },
};
