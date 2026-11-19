import type { Meta, StoryObj } from "@storybook/react-vite";
import { screen, within } from "storybook/test";
import { dropFocus } from "@/stories/PlayHelpers";
import {
  ADMIN_FEEDBACK,
  ADMIN_FEEDBACK_ANON,
  ADMIN_FEEDBACK_DETAIL,
  adminPanelFrame,
  installAdmin,
} from "@/stories/fixtures/Admin";
import { FeedbackPanel } from "./FeedbackPanel";

/** 反馈：状态与类型筛选、列表、详情弹窗（正文、回复记录、改状态、回复表单）。 */
const meta = {
  title: "Admin/FeedbackPanel",
  component: FeedbackPanel,
  tags: ["overlay"],
  decorators: [adminPanelFrame],
} satisfies Meta<typeof FeedbackPanel>;

export default meta;
type Story = StoryObj<typeof meta>;

const ready = () => screen.findByText(ADMIN_FEEDBACK[0].title);

/** 默认筛选「待处理」，第一条标题极长。 */
export const WithData: Story = {
  name: "有数据",
  beforeEach: () => installAdmin(),
  play: async () => {
    await ready();
  },
};

/** 切到「全部状态」：33 条，出现分页。 */
export const AllStatuses: Story = {
  name: "全部状态 · 分页",
  beforeEach: () => installAdmin(),
  play: async ({ userEvent }) => {
    await ready();
    await userEvent.click(screen.getByRole("combobox", { name: "状态" }));
    await userEvent.click(await screen.findByRole("option", { name: "全部状态" }));
    await screen.findByText("1–20 / 33");
    dropFocus();
  },
};

export const Empty: Story = {
  name: "没有反馈",
  beforeEach: () => installAdmin({ "admin/feedback/list": { items: [], total: 0 } }),
  play: async () => {
    await screen.findByText("没有符合条件的反馈");
  },
};

export const Loading: Story = {
  name: "加载中",
  beforeEach: () => installAdmin({ "admin/feedback/list": "pending" }),
};

export const Failed: Story = {
  name: "读取失败",
  beforeEach: () => installAdmin({ "admin/feedback/list": "error" }),
  play: async () => {
    await screen.findByText("反馈列表加载失败");
  },
};

/** 登录用户的反馈：正文、页面与浏览器、两条回复、回复框。 */
export const Detail: Story = {
  name: "详情",
  beforeEach: () => installAdmin(),
  play: async ({ userEvent }) => {
    await userEvent.click(await ready());
    await within(await screen.findByRole("dialog")).findByText(
      ADMIN_FEEDBACK_DETAIL.replies[0].content
    );
    dropFocus();
  },
};

/** 匿名反馈：没有回复框，虚线说明。 */
export const DetailAnonymous: Story = {
  name: "详情 · 匿名",
  beforeEach: () => installAdmin({ "admin/feedback/get": ADMIN_FEEDBACK_ANON }),
  play: async ({ userEvent }) => {
    await userEvent.click((await screen.findAllByText(ADMIN_FEEDBACK[4].title))[0]);
    await within(await screen.findByRole("dialog")).findByText(ADMIN_FEEDBACK_ANON.content);
    dropFocus();
  },
};

export const ReplyFailed: Story = {
  name: "详情 · 回复失败",
  beforeEach: () => installAdmin({ "admin/feedback/reply": "error" }),
  play: async ({ userEvent }) => {
    await userEvent.click(await ready());
    const dialog = within(await screen.findByRole("dialog"));
    await userEvent.type(await dialog.findByLabelText("回复"), "已经修好了，请更新后再试。");
    await userEvent.click(dialog.getByRole("button", { name: "发送回复" }));
    await dialog.findByRole("alert");
    dropFocus();
  },
};
