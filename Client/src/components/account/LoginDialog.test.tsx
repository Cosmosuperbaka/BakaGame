import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ORPCError } from "@orpc/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { AuthRequestError } from "@/lib/Api";
import { useAccountStore } from "@/stores/UseAccountStore";
import { LoginDialog } from "./LoginDialog";

const requestLoginCode = vi.hoisted(() =>
  vi.fn<
    (input: {
      qqNumber: string;
    }) => Promise<{ registered: boolean; resendAfterSeconds: number; qqName: string | null }>
  >()
);
const qqName = vi.hoisted(() => vi.fn<(input: { qqNumber: string }) => Promise<string | null>>());

vi.mock("@/lib/Api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/Api")>()),
  api: { account: { requestLoginCode, qqName } },
}));

const passkeySupported = vi.hoisted(() => vi.fn<() => boolean>());
const passkeySignIn = vi.hoisted(() => vi.fn<() => Promise<void>>());

vi.mock("@/lib/Passkey", () => ({
  passkeySupported,
  signInWithPasskey: passkeySignIn,
  // 组件只关心「拿到一句中文」，映射规则本身在 lib/Passkey.test.ts 里验。
  passkeyErrorMessage: (error: unknown, fallback: string) =>
    error instanceof Error ? error.message : fallback,
}));

const signIn = vi.fn<(input: { email: string; otp: string }) => Promise<void>>();
const originalSignIn = useAccountStore.getState().signIn;
const originalPasskeySignIn = useAccountStore.getState().signInWithPasskey;

beforeEach(() => {
  useAccountStore.setState({ signIn, signInWithPasskey: passkeySignIn });
  passkeySupported.mockReturnValue(true);
  // 回显昵称默认查不到：只有断言回显的用例改成 resolved，其余用例的昵称一律来自发码返回值。
  qqName.mockResolvedValue(null);
});

afterEach(() => {
  useAccountStore.setState({ signIn: originalSignIn, signInWithPasskey: originalPasskeySignIn });
  requestLoginCode.mockReset();
  qqName.mockReset();
  signIn.mockReset();
  passkeySignIn.mockReset();
});

const renderDialog = () => {
  const onOpenChange = vi.fn();
  render(<LoginDialog open onOpenChange={onOpenChange} />);
  return { onOpenChange, user: userEvent.setup() };
};

describe("登录弹窗", () => {
  it("QQ 号合法后在输入框上方展示 qlogo 头像，只收数字", async () => {
    const { user } = renderDialog();
    const input = screen.getByLabelText("QQ 号");
    const send = screen.getByRole("button", { name: "发送验证码" });

    await user.type(input, "12a3");
    expect(input).toHaveValue("123");
    expect(send).toBeDisabled();
    expect(screen.queryByRole("img")).not.toBeInTheDocument();

    await user.type(input, "45");
    const avatar = screen.getByRole("img", { name: "QQ 12345 的头像" });
    expect(avatar).toHaveAttribute("src", "https://q1.qlogo.cn/g?b=qq&nk=12345&s=640");
    expect(avatar).toHaveAttribute("referrerpolicy", "no-referrer");
    // 头像格在字段之上：DOM 顺序即视觉顺序
    expect(avatar.compareDocumentPosition(input) & Node.DOCUMENT_POSITION_FOLLOWING).not.toBe(0);
    // 身份区同时落出 QQ 号一行，与头像一起确认「这是谁的号」
    expect(screen.getByText("QQ 12345")).toBeInTheDocument();
    expect(send).toBeEnabled();
  });

  it("输完 QQ 号即回显昵称，不等发码", async () => {
    qqName.mockResolvedValue("阿狸");
    const { user } = renderDialog();
    const input = screen.getByLabelText("QQ 号");

    await user.type(input, "12345");
    expect(await screen.findByText("阿狸")).toBeInTheDocument();
    expect(qqName).toHaveBeenCalledWith({ qqNumber: "12345" });
    // 回显只是把「这个号是谁」提前说出来，第一步的操作不变
    expect(screen.getByRole("button", { name: "发送验证码" })).toBeEnabled();
  });

  it("回显查不到时不给报错，也不挡住发码", async () => {
    qqName.mockRejectedValue(
      new ORPCError("TOO_MANY_REQUESTS", { message: "昵称查询过于频繁，请稍后再试" })
    );
    requestLoginCode.mockResolvedValue({
      registered: true,
      resendAfterSeconds: 60,
      qqName: "老玩家",
    });
    const { user } = renderDialog();

    await user.type(screen.getByLabelText("QQ 号"), "12345");
    await user.click(screen.getByRole("button", { name: "发送验证码" }));
    expect(await screen.findByText("老玩家")).toBeInTheDocument();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("新账号：发码后在头像下展示将使用的 QQ 昵称，登录参数不带昵称，成功后关闭", async () => {
    requestLoginCode.mockResolvedValue({
      registered: false,
      resendAfterSeconds: 60,
      qqName: "阿狸",
    });
    signIn.mockResolvedValue();
    const { user, onOpenChange } = renderDialog();

    await user.type(screen.getByLabelText("QQ 号"), "12345");
    await user.click(screen.getByRole("button", { name: "发送验证码" }));
    expect(requestLoginCode).toHaveBeenCalledWith({ qqNumber: "12345" });
    expect(await screen.findByRole("heading", { name: "注册账号" })).toBeInTheDocument();
    expect(await screen.findByRole("button", { name: "60 秒后重发" })).toBeDisabled();
    // 收信地址与有效期挂在验证码字段的说明上，不再另起一段描述
    expect(screen.getByText("已发送至 12345@qq.com，5 分钟内有效")).toBeInTheDocument();
    // 昵称强制取自 QQ、不可修改：只有头像下的只读展示，没有昵称输入框
    expect(screen.getByText("阿狸")).toBeInTheDocument();
    expect(screen.queryByLabelText("账号昵称")).not.toBeInTheDocument();

    const submit = screen.getByRole("button", { name: "注册并登录" });
    await user.type(screen.getByLabelText("验证码"), "123456");
    await user.click(submit);

    expect(signIn).toHaveBeenCalledWith({ email: "12345@qq.com", otp: "123456" });
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it("昵称服务不可用时发码被拒，就地提示原因并留在原步骤", async () => {
    requestLoginCode.mockRejectedValueOnce(
      new ORPCError("QQ_NICKNAME_UNAVAILABLE", {
        status: 503,
        message: "暂时无法获取你的 QQ 昵称，新账号注册暂时不可用，请稍后再试",
      })
    );
    const { user } = renderDialog();

    await user.type(screen.getByLabelText("QQ 号"), "12345");
    await user.click(screen.getByRole("button", { name: "发送验证码" }));

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "暂时无法获取你的 QQ 昵称，新账号注册暂时不可用，请稍后再试"
    );
    expect(screen.getByRole("button", { name: "发送验证码" })).toBeEnabled();
    expect(signIn).not.toHaveBeenCalled();
  });

  it("老账号展示服务端回传的昵称；验证码错误就地提示并保留弹窗", async () => {
    requestLoginCode.mockResolvedValue({
      registered: true,
      resendAfterSeconds: 60,
      qqName: "老玩家",
    });
    signIn.mockRejectedValue(new AuthRequestError("INVALID_OTP", "验证码不正确", 400));
    const { user, onOpenChange } = renderDialog();

    await user.type(screen.getByLabelText("QQ 号"), "12345");
    await user.click(screen.getByRole("button", { name: "发送验证码" }));
    await user.type(await screen.findByLabelText("验证码"), "000000");
    // 老号的昵称由服务端回传库中最近同步值，头像下同样展示
    expect(screen.getByText("老玩家")).toBeInTheDocument();
    expect(screen.getByText("QQ 12345")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "登录" }));

    expect(signIn).toHaveBeenCalledWith({ email: "12345@qq.com", otp: "000000" });
    expect(await screen.findByRole("alert")).toHaveTextContent("验证码不正确");
    expect(onOpenChange).not.toHaveBeenCalled();
  });

  it("发码失败显示服务端中文原因，可换个 QQ 号返回", async () => {
    requestLoginCode.mockRejectedValueOnce(
      new ORPCError("TOO_MANY_REQUESTS", { message: "发送太频繁，请稍后再试" })
    );
    requestLoginCode.mockResolvedValueOnce({
      registered: true,
      resendAfterSeconds: 60,
      qqName: null,
    });
    const { user } = renderDialog();

    await user.type(screen.getByLabelText("QQ 号"), "12345");
    await user.click(screen.getByRole("button", { name: "发送验证码" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("发送太频繁，请稍后再试");

    await user.click(screen.getByRole("button", { name: "发送验证码" }));
    await user.click(await screen.findByRole("button", { name: "换个 QQ 号" }));
    expect(screen.getByLabelText("QQ 号")).toHaveValue("12345");
  });

  it("登录说明默认收起，展开后写明用途与 QQ 号边界", async () => {
    const { user } = renderDialog();
    expect(screen.queryByText(/不登录也能游玩/)).not.toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "登录说明" }));
    expect(
      await screen.findByText("不登录也能游玩并匿名提交反馈；匿名反馈无法查看结果与回复。")
    ).toBeInTheDocument();
    expect(screen.getByText(/查看自己反馈的回复/)).toBeInTheDocument();
    expect(screen.getByText(/不索要你的 QQ 密码/)).toBeInTheDocument();
    expect(screen.getByText(/通行密钥在登录后的「账号资料」里添加/)).toBeInTheDocument();
  });

  it("支持 WebAuthn 时页脚并列给出通行密钥入口，登录成功后关闭弹窗", async () => {
    passkeySignIn.mockResolvedValue();
    const { user, onOpenChange } = renderDialog();

    const passkey = screen.getByRole("button", { name: "通行密钥" });
    // 与发送验证码并列在同一枚页脚里：切步不因为多一个入口而跳高度
    expect(passkey).toBeEnabled();
    await user.click(passkey);

    expect(passkeySignIn).toHaveBeenCalled();
    expect(signIn).not.toHaveBeenCalled();
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it("第二步不再出现通行密钥入口；验证失败就地提示且不关弹窗", async () => {
    requestLoginCode.mockResolvedValue({
      registered: true,
      resendAfterSeconds: 60,
      qqName: null,
    });
    passkeySignIn.mockRejectedValue(new Error("本机没有可用的通行密钥"));
    const { user, onOpenChange } = renderDialog();

    await user.click(screen.getByRole("button", { name: "通行密钥" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("本机没有可用的通行密钥");
    expect(onOpenChange).not.toHaveBeenCalled();

    // 通行密钥失败后改走验证码那一步：页脚只剩「换个 QQ 号 + 登录」
    await user.type(screen.getByLabelText("QQ 号"), "12345");
    await user.click(screen.getByRole("button", { name: "发送验证码" }));
    expect(await screen.findByLabelText("验证码")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "通行密钥" })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "登录" })).toBeDisabled();
  });

  it("不支持 WebAuthn 的浏览器整段入口消失，验证码照常", async () => {
    passkeySupported.mockReturnValue(false);
    const { user } = renderDialog();

    expect(screen.queryByRole("button", { name: "通行密钥" })).not.toBeInTheDocument();
    await user.type(screen.getByLabelText("QQ 号"), "12345");
    expect(screen.getByRole("button", { name: "发送验证码" })).toBeEnabled();
  });
});
