import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AccountProfile } from "@bakagame/shared";
import { AuthRequestError } from "@/lib/Api";
import { useAccountStore } from "@/stores/UseAccountStore";
import { ProfileDialog } from "./ProfileDialog";

const passkeySupported = vi.hoisted(() => vi.fn<() => boolean>());
const platformAuthenticatorAvailable = vi.hoisted(() =>
  vi.fn<() => Promise<boolean | undefined>>()
);
const listPasskeys = vi.hoisted(() => vi.fn<() => Promise<unknown[]>>());
const addPasskey = vi.hoisted(() =>
  vi.fn<(attachment?: "platform" | "cross-platform") => Promise<void>>()
);
const removePasskey = vi.hoisted(() => vi.fn<(id: string) => Promise<void>>());
const renamePasskey = vi.hoisted(() => vi.fn<(id: string, name: string) => Promise<void>>());

vi.mock("@/lib/Passkey", () => ({
  PASSKEY_NAME_MAX: 40,
  passkeySupported,
  platformAuthenticatorAvailable,
  listPasskeys,
  addPasskey,
  removePasskey,
  renamePasskey,
  // 组件只关心「拿到一句中文」，映射规则本身在 lib/Passkey.test.ts 里验。
  passkeyErrorMessage: (error: unknown, fallback: string) =>
    error instanceof Error ? error.message : fallback,
  passkeyRegistrationErrorMessage: (
    error: unknown,
    _attachment: unknown,
    _platform: unknown,
    fallback: string
  ) => (error instanceof Error ? error.message : fallback),
}));

const profile: AccountProfile = {
  id: "u-1",
  name: "测试玩家",
  qqNumber: "12345",
  image: null,
  showQq: false,
  role: "user",
  createdAt: "2026-10-01T00:00:00.000Z",
  badges: [],
};

const entry = (id: string, name: string | null) => ({
  id,
  name,
  createdAt: "2026-10-02T03:04:00.000Z",
});

/** 假库：列表与改名共用同一个数组，省得按调用次数排 mock 的返回值。 */
const plantPasskeys = (names: Record<string, string>) => {
  const items = Object.entries(names).map(([id, name]) => entry(id, name));
  listPasskeys.mockImplementation(async () => items.map((item) => ({ ...item })));
  renamePasskey.mockImplementation(async (id, name) => {
    const target = items.find((item) => item.id === id);
    if (target) target.name = name;
  });
  return items;
};

beforeEach(() => {
  useAccountStore.setState({ profile, status: "signedIn" });
  passkeySupported.mockReturnValue(true);
  platformAuthenticatorAvailable.mockResolvedValue(true);
  listPasskeys.mockResolvedValue([]);
  addPasskey.mockResolvedValue();
  removePasskey.mockResolvedValue();
  renamePasskey.mockResolvedValue();
});

afterEach(() => {
  platformAuthenticatorAvailable.mockReset();
  listPasskeys.mockReset();
  addPasskey.mockReset();
  removePasskey.mockReset();
  renamePasskey.mockReset();
});

const renderDialog = () => {
  const onOpenChange = vi.fn();
  render(<ProfileDialog open onOpenChange={onOpenChange} />);
  return { onOpenChange, user: userEvent.setup() };
};

describe("账号资料弹窗的通行密钥", () => {
  it("列出已有密钥：无名兜底，按条移除后重取列表", async () => {
    listPasskeys.mockResolvedValue([entry("pk-1", "这台电脑"), entry("pk-2", null)]);
    const { user } = renderDialog();

    expect(await screen.findByText("这台电脑")).toBeInTheDocument();
    expect(screen.getByText("未命名通行密钥")).toBeInTheDocument();

    await user.click(screen.getAllByRole("button", { name: "移除" })[1]);
    expect(removePasskey).toHaveBeenCalledWith("pk-2");
    await vi.waitFor(() => expect(listPasskeys).toHaveBeenCalledTimes(2));
  });

  it("两条添加入口分别要求本机与跨平台验证器，成功后重取列表", async () => {
    listPasskeys.mockResolvedValueOnce([]).mockResolvedValueOnce([entry("pk-9", "手机")]);
    const { user } = renderDialog();

    expect(await screen.findByText("还没有添加通行密钥。")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "用密码管理器或安全密钥" }));

    expect(addPasskey).toHaveBeenCalledWith("cross-platform");
    expect(await screen.findByText("手机")).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "用本机解锁" }));
    expect(addPasskey).toHaveBeenLastCalledWith("platform");
  });

  it("系统验证器不可用时禁用本机入口，跨设备入口照常", async () => {
    platformAuthenticatorAvailable.mockResolvedValue(false);
    const { user } = renderDialog();

    const platform = await screen.findByRole("button", { name: "用本机解锁" });
    await vi.waitFor(() => expect(platform).toBeDisabled());
    expect(screen.getByText("本设备未检测到系统验证器。")).toBeInTheDocument();

    const cross = screen.getByRole("button", { name: "用密码管理器或安全密钥" });
    expect(cross).toBeEnabled();
    await user.click(cross);
    expect(addPasskey).toHaveBeenCalledWith("cross-platform");
  });

  it("点铅笔就地换成输入框，回车提交并刷新列表", async () => {
    plantPasskeys({ "pk-1": "这台电脑" });
    const { user } = renderDialog();

    await user.click(await screen.findByRole("button", { name: "重命名「这台电脑」" }));
    const input = screen.getByLabelText("通行密钥名称");
    expect(input).toHaveValue("这台电脑");

    await user.clear(input);
    await user.type(input, "办公室电脑");
    await user.keyboard("{Enter}");

    expect(renamePasskey).toHaveBeenCalledWith("pk-1", "办公室电脑");
    expect(await screen.findByText("办公室电脑")).toBeInTheDocument();
    expect(screen.queryByLabelText("通行密钥名称")).not.toBeInTheDocument();
    await vi.waitFor(() => expect(listPasskeys).toHaveBeenCalledTimes(2));
  });

  it("Esc 只放弃改名，不发请求也不关弹窗", async () => {
    plantPasskeys({ "pk-1": "这台电脑" });
    const { onOpenChange, user } = renderDialog();

    await user.click(await screen.findByRole("button", { name: "重命名「这台电脑」" }));
    const input = screen.getByLabelText("通行密钥名称");
    await user.clear(input);
    await user.type(input, "改了一半");
    await user.keyboard("{Escape}");

    expect(renamePasskey).not.toHaveBeenCalled();
    expect(screen.getByText("这台电脑")).toBeInTheDocument();
    expect(onOpenChange).not.toHaveBeenCalled();
  });

  it("空名与没改动的名字都不发请求", async () => {
    plantPasskeys({ "pk-1": "这台电脑" });
    const { user } = renderDialog();

    // 清空后 Tab 走开触发 blur：空名不是一次改名，只把输入框收回去
    await user.click(await screen.findByRole("button", { name: "重命名「这台电脑」" }));
    await user.clear(screen.getByLabelText("通行密钥名称"));
    await user.keyboard("{Tab}");
    expect(renamePasskey).not.toHaveBeenCalled();
    expect(screen.getByText("这台电脑")).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "重命名「这台电脑」" }));
    await user.keyboard("{Enter}");
    expect(renamePasskey).not.toHaveBeenCalled();
    expect(screen.getByText("这台电脑")).toBeInTheDocument();
  });

  it("改名失败给出中文原因，列表仍留着原名", async () => {
    plantPasskeys({ "pk-1": "这台电脑" });
    renamePasskey.mockRejectedValue(
      new AuthRequestError("PASSKEY_NOT_FOUND", "通行密钥不存在", 404)
    );
    const { user } = renderDialog();

    await user.click(await screen.findByRole("button", { name: "重命名「这台电脑」" }));
    await user.clear(screen.getByLabelText("通行密钥名称"));
    await user.type(screen.getByLabelText("通行密钥名称"), "换名");
    await user.keyboard("{Enter}");

    expect(await screen.findByRole("alert")).toHaveTextContent("通行密钥不存在");
    expect(screen.getByText("这台电脑")).toBeInTheDocument();
  });

  it("新鲜登录超时的中文原因就地提示，不静默重登", async () => {
    addPasskey.mockRejectedValue(
      new AuthRequestError(
        "SESSION_NOT_FRESH",
        "这次登录已超过一天，请重新登录后再添加通行密钥",
        403
      )
    );
    const { user } = renderDialog();

    await user.click(await screen.findByRole("button", { name: "用密码管理器或安全密钥" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("这次登录已超过一天");
  });

  it("读取失败时列表位置显示原因，添加按钮仍可用", async () => {
    listPasskeys.mockRejectedValue(new AuthRequestError("UNAUTHORIZED", "请先登录", 401));
    const { user } = renderDialog();

    expect(await screen.findByText("请先登录")).toBeInTheDocument();
    const cross = screen.getByRole("button", { name: "用密码管理器或安全密钥" });
    expect(cross).toBeEnabled();
    await user.click(cross);
    expect(addPasskey).toHaveBeenCalledOnce();
  });

  it("不支持 WebAuthn 的浏览器整节消失", async () => {
    passkeySupported.mockReturnValue(false);
    renderDialog();

    expect(await screen.findByText("资料卡显示 QQ 号")).toBeInTheDocument();
    expect(screen.queryByText("通行密钥")).not.toBeInTheDocument();
    expect(listPasskeys).not.toHaveBeenCalled();
  });
});
