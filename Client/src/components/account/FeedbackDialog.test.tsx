import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TooltipProvider } from "@/components/ui/Tooltip";
import { useAccountStore } from "@/stores/UseAccountStore";
import { FeedbackDialog } from "./FeedbackDialog";

const create = vi.hoisted(() => vi.fn());
const listMine = vi.hoisted(() => vi.fn());
const get = vi.hoisted(() => vi.fn());

vi.mock("@/lib/Api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/Api")>()),
  api: { feedback: { create, listMine, get } },
}));

const renderDialog = () =>
  render(
    <TooltipProvider>
      <FeedbackDialog open onOpenChange={() => {}} />
    </TooltipProvider>
  );

beforeEach(() => {
  create.mockResolvedValue({
    id: "feedback-1",
    kind: "suggestion",
    title: "匿名建议",
    status: "open",
    createdAt: new Date().toISOString(),
    lastReplyAt: null,
    unread: false,
  });
  listMine.mockResolvedValue({ items: [], unread: 0 });
});

afterEach(() => {
  useAccountStore.setState({ status: "loading", profile: null, unreadFeedback: 0 });
  create.mockReset();
  listMine.mockReset();
  get.mockReset();
});

describe("反馈弹窗", () => {
  it("未登录只提交匿名反馈，不拉取我的反馈", async () => {
    useAccountStore.setState({ status: "unavailable", profile: null, unreadFeedback: 0 });
    const user = userEvent.setup();
    renderDialog();

    expect(screen.getByText(/匿名反馈不会展示结果/)).toBeInTheDocument();
    expect(screen.queryByRole("tab", { name: /我的反馈/ })).not.toBeInTheDocument();
    expect(listMine).not.toHaveBeenCalled();

    await user.type(screen.getByLabelText("标题"), "匿名建议");
    await user.type(screen.getByLabelText("详细说明"), "无需登录也能提交");
    await user.click(screen.getByRole("button", { name: "提交反馈" }));

    expect(create).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: "suggestion",
        title: "匿名建议",
        content: "无需登录也能提交",
      })
    );
    expect(await screen.findByText("已收到你的匿名反馈，感谢！")).toBeInTheDocument();
    expect(listMine).not.toHaveBeenCalled();
  });

  it("登录用户显示我的反馈并拉取列表", async () => {
    useAccountStore.setState({ status: "signedIn", profile: null, unreadFeedback: 0 });
    renderDialog();

    expect(await screen.findByRole("tab", { name: "我的反馈" })).toBeInTheDocument();
    expect(listMine).toHaveBeenCalledTimes(1);
  });
});
