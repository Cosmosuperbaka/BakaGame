import { useState } from "react";
import type { Meta, StoryObj } from "@storybook/react-vite";
import { screen, within } from "storybook/test";
import { dropFocus } from "@/stories/PlayHelpers";
import { STORY_PROFILE, presetAccount, stubApi } from "@/stories/fixtures/Account";
import { FeedbackDialog } from "./FeedbackDialog";

/** 反馈弹窗：游客只能提交；登录后多一个「我的反馈」列表与详情。接口由故事桩住。 */
function OpenFeedback() {
  const [open, setOpen] = useState(true);
  return <FeedbackDialog open={open} onOpenChange={setOpen} onRequestLogin={() => {}} />;
}

const LIST = {
  unread: 1,
  items: [
    {
      id: "f-1",
      kind: "bug",
      title: "猜歌房间里搜索框偶尔不出结果，刷新后才恢复",
      status: "processing",
      createdAt: "2026-12-28T09:00:00.000Z",
      lastReplyAt: "2026-12-31T20:00:00.000Z",
      unread: true,
    },
    {
      id: "f-2",
      kind: "suggestion",
      title: "希望谁是卧底可以自定义词库",
      status: "resolved",
      createdAt: "2026-12-01T09:00:00.000Z",
      lastReplyAt: null,
      unread: false,
    },
    {
      id: "f-3",
      kind: "suggestion",
      title: "深色模式下结算表稍暗",
      status: "closed",
      createdAt: "2026-11-11T09:00:00.000Z",
      lastReplyAt: null,
      unread: false,
    },
  ],
};

const DETAIL = {
  ...LIST.items[0],
  content: "在 CEE 多人房间也遇到过一次。\n复现：连续输入三个字后删掉再输入。",
  page: "/songuessr/room/1234",
  replies: [
    {
      id: 1,
      content: "已复现，是搜索请求被旧结果覆盖，下个版本修。",
      createdAt: "2026-12-31T20:00:00.000Z",
    },
  ],
};

function signedIn() {
  const restoreAccount = presetAccount({
    status: "signedIn",
    profile: STORY_PROFILE,
    unreadFeedback: 1,
  });
  const restoreApi = stubApi({ "feedback/listMine": LIST, "feedback/get": DETAIL });
  return () => {
    restoreApi();
    restoreAccount();
  };
}

const meta = {
  title: "账号/FeedbackDialog",
  component: FeedbackDialog,
  tags: ["overlay"],
  args: { open: true, onOpenChange: () => {} },
  render: () => <OpenFeedback />,
} satisfies Meta<typeof FeedbackDialog>;

export default meta;
type Story = StoryObj<typeof meta>;

/** 游客：类型、标题、详细说明三个字段与「登录并提交 / 匿名提交」。 */
export const Guest: Story = {
  name: "游客提交",
  beforeEach: () => presetAccount({ status: "guest" }),
  play: async ({ userEvent }) => {
    const scope = within(await screen.findByRole("dialog"));
    await userEvent.type(scope.getByLabelText("标题"), "结算页按钮太小");
    await userEvent.type(scope.getByLabelText("详细说明"), "手机上不好点。");
    dropFocus();
  },
};

/** 游客点「匿名提交」后的二次确认。 */
export const GuestConfirm: Story = {
  name: "游客匿名确认",
  beforeEach: () => presetAccount({ status: "guest" }),
  play: async ({ userEvent }) => {
    const scope = within(await screen.findByRole("dialog"));
    await userEvent.type(scope.getByLabelText("标题"), "结算页按钮太小");
    await userEvent.type(scope.getByLabelText("详细说明"), "手机上不好点。");
    await userEvent.click(scope.getByRole("button", { name: "匿名提交" }));
    await scope.findByText("是否确定提交匿名反馈？");
    dropFocus();
  },
};

/** 登录且有未读回复：默认落在「我的反馈」列表。 */
export const MyList: Story = {
  name: "我的反馈列表",
  beforeEach: signedIn,
  play: async () => {
    await within(await screen.findByRole("dialog")).findByText("希望谁是卧底可以自定义词库");
  },
};

/** 点开一条：正文、提交时间与管理员回复。 */
export const Thread: Story = {
  name: "反馈详情",
  beforeEach: signedIn,
  play: async ({ userEvent }) => {
    const scope = within(await screen.findByRole("dialog"));
    await userEvent.click(await scope.findByText(LIST.items[0].title));
    await scope.findByText(DETAIL.replies[0].content);
    dropFocus();
  },
};

export const ListLoading: Story = {
  name: "列表读取中",
  beforeEach: () => {
    const restoreAccount = presetAccount({
      status: "signedIn",
      profile: STORY_PROFILE,
      unreadFeedback: 1,
    });
    const restoreApi = stubApi({ "feedback/listMine": "pending" });
    return () => {
      restoreApi();
      restoreAccount();
    };
  },
};

export const ListEmpty: Story = {
  name: "列表为空",
  beforeEach: () => {
    const restoreAccount = presetAccount({ status: "signedIn", profile: STORY_PROFILE });
    const restoreApi = stubApi({ "feedback/listMine": { unread: 0, items: [] } });
    return () => {
      restoreApi();
      restoreAccount();
    };
  },
  play: async ({ userEvent }) => {
    const scope = within(await screen.findByRole("dialog"));
    await userEvent.click(scope.getByRole("tab", { name: "我的反馈" }));
    await scope.findByText("还没有提交过反馈");
    dropFocus();
  },
};
