import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ORPCError } from "@orpc/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { AuthRequestError } from "@/lib/Api";
import { useAccountStore } from "@/stores/UseAccountStore";
import { LoginDialog } from "./LoginDialog";

const requestLoginCode = vi.hoisted(() => vi.fn<(input: { qqNumber: string }) => Promise<{ registered: boolean; resendAfterSeconds: number }>>());

vi.mock("@/lib/Api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/Api")>()),
  api: { account: { requestLoginCode } },
}));

const signIn = vi.fn<(input: { email: string; otp: string; name?: string }) => Promise<void>>();
const originalSignIn = useAccountStore.getState().signIn;

beforeEach(() => {
  useAccountStore.setState({ signIn });
});

afterEach(() => {
  useAccountStore.setState({ signIn: originalSignIn });
  requestLoginCode.mockReset();
  signIn.mockReset();
});

const renderDialog = () => {
  const onOpenChange = vi.fn();
  render(<LoginDialog open onOpenChange={onOpenChange} />);
  return { onOpenChange, user: userEvent.setup() };
};

describe("登录弹窗", () => {
  it("QQ 号合法后才展示 qlogo 头像确认，只收数字", async () => {
    const { user } = renderDialog();
    const input = screen.getByLabelText("QQ 号");
    const send = screen.getByRole("button", { name: "是我，发送验证码" });

    await user.type(input, "12a3");
    expect(input).toHaveValue("123");
    expect(send).toBeDisabled();
    expect(screen.queryByText("这是你的 QQ 吗？")).not.toBeInTheDocument();

    await user.type(input, "45");
    const avatar = screen.getByRole("img", { name: "QQ 12345 的头像" });
    expect(avatar).toHaveAttribute("src", "https://q1.qlogo.cn/g?b=qq&nk=12345&s=640");
    expect(avatar).toHaveAttribute("referrerpolicy", "no-referrer");
    expect(screen.getByText("12345@qq.com")).toBeInTheDocument();
    expect(send).toBeEnabled();
  });

  it("新账号：发码后要求填写账号昵称，登录参数带上昵称，成功后关闭", async () => {
    requestLoginCode.mockResolvedValue({ registered: false, resendAfterSeconds: 60 });
    signIn.mockResolvedValue();
    const { user, onOpenChange } = renderDialog();

    await user.type(screen.getByLabelText("QQ 号"), "12345");
    await user.click(screen.getByRole("button", { name: "是我，发送验证码" }));
    expect(requestLoginCode).toHaveBeenCalledWith({ qqNumber: "12345" });
    expect(await screen.findByRole("heading", { name: "注册账号" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "60 秒后重发" })).toBeDisabled();

    const submit = screen.getByRole("button", { name: "注册并登录" });
    await user.type(screen.getByLabelText("验证码"), "123456");
    expect(submit).toBeDisabled();
    await user.type(screen.getByLabelText("账号昵称"), "  阿狸  ");
    await user.click(submit);

    expect(signIn).toHaveBeenCalledWith({ email: "12345@qq.com", otp: "123456", name: "阿狸" });
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it("老账号不填昵称；验证码错误就地提示并保留弹窗", async () => {
    requestLoginCode.mockResolvedValue({ registered: true, resendAfterSeconds: 60 });
    signIn.mockRejectedValue(new AuthRequestError("INVALID_OTP", "验证码不正确", 400));
    const { user, onOpenChange } = renderDialog();

    await user.type(screen.getByLabelText("QQ 号"), "12345");
    await user.click(screen.getByRole("button", { name: "是我，发送验证码" }));
    await user.type(await screen.findByLabelText("验证码"), "000000");
    expect(screen.queryByLabelText("账号昵称")).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "登录" }));

    expect(signIn).toHaveBeenCalledWith({ email: "12345@qq.com", otp: "000000" });
    expect(await screen.findByRole("alert")).toHaveTextContent("验证码不正确");
    expect(onOpenChange).not.toHaveBeenCalled();
  });

  it("发码失败显示服务端中文原因，可换个 QQ 号返回", async () => {
    requestLoginCode.mockRejectedValueOnce(new ORPCError("TOO_MANY_REQUESTS", { message: "发送太频繁，请稍后再试" }));
    requestLoginCode.mockResolvedValueOnce({ registered: true, resendAfterSeconds: 60 });
    const { user } = renderDialog();

    await user.type(screen.getByLabelText("QQ 号"), "12345");
    await user.click(screen.getByRole("button", { name: "是我，发送验证码" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("发送太频繁，请稍后再试");

    await user.click(screen.getByRole("button", { name: "是我，发送验证码" }));
    await user.click(await screen.findByRole("button", { name: "换个 QQ 号" }));
    expect(screen.getByLabelText("QQ 号")).toHaveValue("12345");
  });
});
