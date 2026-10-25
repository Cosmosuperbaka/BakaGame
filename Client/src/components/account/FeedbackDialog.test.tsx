import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TooltipProvider } from "@/components/ui/Tooltip";
import { useAccountStore } from "@/stores/UseAccountStore";
import { FeedbackDialog, type FeedbackDraft } from "./FeedbackDialog";

const create = vi.hoisted(() => vi.fn());
const listMine = vi.hoisted(() => vi.fn());
const get = vi.hoisted(() => vi.fn());

vi.mock("@/lib/Api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/Api")>()),
  api: { feedback: { create, listMine, get } },
}));

const renderDialog = (
  props: {
    draft?: FeedbackDraft;
    autoSubmit?: boolean;
    onAutoSubmitted?: () => void;
    onRequestLogin?: (draft: FeedbackDraft) => void;
  } = {}
) =>
  render(
    <TooltipProvider>
      <FeedbackDialog open onOpenChange={() => {}} {...props} />
    </TooltipProvider>
  );

const fillDraft = async (user: ReturnType<typeof userEvent.setup>) => {
  await user.type(screen.getByLabelText("标题"), "匿名建议");
  await user.type(screen.getByLabelText("详细说明"), "无需登录也能提交");
};

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
  it("未登录给出匿名提交与登录并提交，匿名提交需二次确认", async () => {
    useAccountStore.setState({ status: "unavailable", profile: null, unreadFeedback: 0 });
    const user = userEvent.setup();
    const onRequestLogin = vi.fn();
    renderDialog({ onRequestLogin });

    expect(screen.getByText("建议与问题都会被认真看到。")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "匿名提交" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "登录并提交" })).toBeDisabled();
    expect(screen.queryByRole("tab", { name: /我的反馈/ })).not.toBeInTheDocument();
    expect(listMine).not.toHaveBeenCalled();

    await fillDraft(user);
    await user.click(screen.getByRole("button", { name: "匿名提交" }));

    expect(screen.getByText("是否确定提交匿名反馈？")).toBeInTheDocument();
    expect(screen.getByText("反馈的优先级可能较低，您也无法看到反馈的结果。")).toBeInTheDocument();
    expect(create).not.toHaveBeenCalled();

    await user.click(screen.getByRole("button", { name: "取消" }));
    expect(screen.queryByText("是否确定提交匿名反馈？")).not.toBeInTheDocument();
    expect(screen.getByLabelText("标题")).toHaveValue("匿名建议");

    await user.click(screen.getByRole("button", { name: "匿名提交" }));
    await user.click(screen.getByRole("button", { name: "确定提交" }));

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

  it("登录并提交把当前草稿交给登录流程", async () => {
    useAccountStore.setState({ status: "unavailable", profile: null, unreadFeedback: 0 });
    const user = userEvent.setup();
    const onRequestLogin = vi.fn();
    renderDialog({ onRequestLogin });

    await fillDraft(user);
    await user.click(screen.getByRole("button", { name: "登录并提交" }));

    expect(onRequestLogin).toHaveBeenCalledWith({
      kind: "suggestion",
      title: "匿名建议",
      content: "无需登录也能提交",
    });
    expect(create).not.toHaveBeenCalled();
  });

  it("登录成功后自动提交登录前的草稿", async () => {
    useAccountStore.setState({ status: "signedIn", profile: null, unreadFeedback: 0 });
    const onAutoSubmitted = vi.fn();
    renderDialog({
      draft: { kind: "bug", title: "登录后的反馈", content: "保留的内容" },
      autoSubmit: true,
      onAutoSubmitted,
    });

    expect(create).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: "bug",
        title: "登录后的反馈",
        content: "保留的内容",
      })
    );
    expect(onAutoSubmitted).toHaveBeenCalledTimes(1);
    expect(await screen.findByText("已收到你的反馈，感谢！")).toBeInTheDocument();
    // 打开时拉一次，提交成功切到「我的反馈」后再刷新一次。
    expect(listMine).toHaveBeenCalledTimes(2);
  });

  it("登录用户显示我的反馈并拉取列表", async () => {
    useAccountStore.setState({ status: "signedIn", profile: null, unreadFeedback: 0 });
    renderDialog();

    expect(await screen.findByRole("tab", { name: "我的反馈" })).toBeInTheDocument();
    expect(listMine).toHaveBeenCalledTimes(1);
  });
});
