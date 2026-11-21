import { fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ORPCError } from "@orpc/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { AuthRequestError } from "@/lib/Api";
import { useAccountStore } from "@/stores/UseAccountStore";
import { LoginDialog } from "./LoginDialog";

const requestLoginCode = vi.hoisted(() =>
  vi.fn<
    (input: { qqNumber: string }) => Promise<{ registered: boolean; resendAfterSeconds: number }>
  >()
);

vi.mock("@/lib/Api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/Api")>()),
  api: { account: { requestLoginCode } },
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

const signIn = vi.fn<(input: { email: string; otp: string; name?: string }) => Promise<void>>();
const originalSignIn = useAccountStore.getState().signIn;
const originalPasskeySignIn = useAccountStore.getState().signInWithPasskey;

beforeEach(() => {
  useAccountStore.setState({ signIn, signInWithPasskey: passkeySignIn });
  passkeySupported.mockReturnValue(true);
});

afterEach(() => {
  useAccountStore.setState({ signIn: originalSignIn, signInWithPasskey: originalPasskeySignIn });
  requestLoginCode.mockReset();
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
    // 头像等停输后才出现：敲字过程中不逐位去第三方取图。
    const avatar = await screen.findByRole("img", { name: "QQ 12345 的头像" });
    expect(avatar).toHaveAttribute("src", "https://q1.qlogo.cn/g?b=qq&nk=12345&s=100");
    expect(avatar).toHaveAttribute("referrerpolicy", "no-referrer");
    // 头像格在字段之上：DOM 顺序即视觉顺序
    expect(avatar.compareDocumentPosition(input) & Node.DOCUMENT_POSITION_FOLLOWING).not.toBe(0);
    // 身份区同时落出 QQ 号一行，与头像一起确认「这是谁的号」
    expect(screen.getByText("QQ 12345")).toBeInTheDocument();
    expect(send).toBeEnabled();
  });

  it("连续敲字期间不取头像，停输后只取最终号码的一张小图", async () => {
    render(<LoginDialog open onOpenChange={vi.fn()} />);
    const input = screen.getByLabelText("QQ 号");
    // 记下期间出现过的每一个 <img> 地址：浏览器一旦见到 src 就会发请求，中间态也算一次。
    const requested = new Set<string>();
    const observer = new MutationObserver((records) => {
      for (const record of records) {
        // 只看记录里的新增节点：中间态的 <img> 可能在回调执行前就已被后一个换掉。
        record.addedNodes.forEach((node) => {
          if (!(node instanceof Element)) return;
          const images =
            node instanceof HTMLImageElement ? [node] : [...node.querySelectorAll("img")];
          images.forEach((image) => requested.add(image.getAttribute("src") ?? ""));
        });
      }
    });
    observer.observe(document.body, { subtree: true, childList: true, attributes: true });
    try {
      for (const value of ["12345", "123456", "1234567", "12345678"]) {
        fireEvent.change(input, { target: { value } });
      }
      const avatar = await screen.findByRole("img", { name: "QQ 12345678 的头像" });
      expect(avatar).toHaveAttribute("src", "https://q1.qlogo.cn/g?b=qq&nk=12345678&s=100");
      expect([...requested]).toEqual(["https://q1.qlogo.cn/g?b=qq&nk=12345678&s=100"]);
    } finally {
      observer.disconnect();
    }
  });

  it("验证码登录在途时再次提交（回车）不会重复登录", async () => {
    requestLoginCode.mockResolvedValue({ registered: true, resendAfterSeconds: 60 });
    signIn.mockReturnValue(new Promise<void>(() => {}));
    const { user } = renderDialog();
    await user.type(screen.getByLabelText("QQ 号"), "12345");
    await user.click(screen.getByRole("button", { name: "发送验证码" }));
    await user.type(await screen.findByLabelText("验证码"), "123456");

    const form = screen.getByLabelText("验证码").closest("form")!;
    fireEvent.submit(form);
    fireEvent.submit(form);
    fireEvent.submit(form);
    expect(signIn).toHaveBeenCalledTimes(1);
  });

  it("发码在途时再次提交（回车）不会重复发码", async () => {
    requestLoginCode.mockReturnValue(new Promise(() => {}));
    const { user } = renderDialog();
    await user.type(screen.getByLabelText("QQ 号"), "12345");

    const form = screen.getByLabelText("QQ 号").closest("form")!;
    fireEvent.submit(form);
    fireEvent.submit(form);
    expect(requestLoginCode).toHaveBeenCalledTimes(1);
  });

  it("新账号：发码后要求自填账号昵称，边填边在头像下回显，登录参数带清洗后的昵称", async () => {
    requestLoginCode.mockResolvedValue({ registered: false, resendAfterSeconds: 60 });
    signIn.mockResolvedValue();
    const { user, onOpenChange } = renderDialog();

    await user.type(screen.getByLabelText("QQ 号"), "12345");
    await user.click(screen.getByRole("button", { name: "发送验证码" }));
    expect(requestLoginCode).toHaveBeenCalledWith({ qqNumber: "12345" });
    expect(await screen.findByRole("heading", { name: "注册账号" })).toBeInTheDocument();
    expect(await screen.findByRole("button", { name: "60 秒后重发" })).toBeDisabled();
    // 收信地址与有效期挂在验证码字段的说明上，不再另起一段描述
    expect(screen.getByText("已发送至 12345@qq.com，5 分钟内有效")).toBeInTheDocument();
    const nameInput = screen.getByLabelText("账号昵称");
    expect(nameInput).toHaveFocus();
    expect(screen.getByText("注册后可在账号资料里修改，每 7 天一次")).toBeInTheDocument();

    const submit = screen.getByRole("button", { name: "注册并登录" });
    await user.type(screen.getByLabelText("验证码"), "123456");
    // 没填昵称（或只有空白）时不能提交：提交了也只会被服务端拒绝
    expect(submit).toBeDisabled();
    await user.type(nameInput, "   ");
    expect(submit).toBeDisabled();

    await user.type(nameInput, "阿狸  酱 ");
    expect(screen.getByText("阿狸 酱")).toBeInTheDocument();
    await user.click(submit);

    expect(signIn).toHaveBeenCalledWith({ email: "12345@qq.com", otp: "123456", name: "阿狸 酱" });
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it("昵称被服务端拒绝时提示落在昵称字段，验证码保留可改名重试", async () => {
    requestLoginCode.mockResolvedValue({ registered: false, resendAfterSeconds: 60 });
    signIn.mockRejectedValueOnce(
      new AuthRequestError("TEXT_SENSITIVE", "内容包含不允许的词语，请修改", 400)
    );
    signIn.mockResolvedValueOnce();
    const { user, onOpenChange } = renderDialog();

    await user.type(screen.getByLabelText("QQ 号"), "12345");
    await user.click(screen.getByRole("button", { name: "发送验证码" }));
    await user.type(await screen.findByLabelText("账号昵称"), "不行的名字");
    await user.type(screen.getByLabelText("验证码"), "123456");
    await user.click(screen.getByRole("button", { name: "注册并登录" }));

    const nameInput = screen.getByLabelText("账号昵称");
    expect(await screen.findByRole("alert")).toHaveTextContent("内容包含不允许的词语，请修改");
    expect(nameInput).toHaveAttribute("aria-invalid", "true");
    expect(onOpenChange).not.toHaveBeenCalled();

    await user.clear(nameInput);
    await user.type(nameInput, "正经名字");
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "注册并登录" }));
    expect(signIn).toHaveBeenLastCalledWith({
      email: "12345@qq.com",
      otp: "123456",
      name: "正经名字",
    });
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it("老账号不需要填昵称；验证码错误就地提示并保留弹窗", async () => {
    requestLoginCode.mockResolvedValue({ registered: true, resendAfterSeconds: 60 });
    signIn.mockRejectedValue(new AuthRequestError("INVALID_OTP", "验证码不正确", 400));
    const { user, onOpenChange } = renderDialog();

    await user.type(screen.getByLabelText("QQ 号"), "12345");
    await user.click(screen.getByRole("button", { name: "发送验证码" }));
    await user.type(await screen.findByLabelText("验证码"), "000000");
    expect(screen.queryByLabelText("账号昵称")).not.toBeInTheDocument();
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
