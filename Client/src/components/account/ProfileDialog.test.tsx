import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AccountProfile } from "@/types";
import { AuthRequestError } from "@/lib/Api";
import { useAccountStore } from "@/stores/UseAccountStore";
import { ProfileDialog } from "./ProfileDialog";

const passkeySupported = vi.hoisted(() => vi.fn<() => boolean>());
const listPasskeys = vi.hoisted(() => vi.fn<() => Promise<unknown[]>>());
const addPasskey = vi.hoisted(() => vi.fn<() => Promise<void>>());
const removePasskey = vi.hoisted(() => vi.fn<(id: string) => Promise<void>>());

vi.mock("@/lib/Passkey", () => ({
  passkeySupported,
  listPasskeys,
  addPasskey,
  removePasskey,
  // 组件只关心「拿到一句中文」，映射规则本身在 lib/Passkey.test.ts 里验。
  passkeyErrorMessage: (error: unknown, fallback: string) =>
    error instanceof Error ? error.message : fallback,
}));

const profile: AccountProfile = {
  id: "u-1",
  name: "测试玩家",
  qqNumber: "12345",
  image: null,
  showQq: false,
  role: "user",
  createdAt: "2026-10-01T00:00:00.000Z",
};

const entry = (id: string, name: string | null) => ({
  id,
  name,
  createdAt: "2026-10-02T03:04:00.000Z",
});

beforeEach(() => {
  useAccountStore.setState({ profile, status: "signedIn" });
  passkeySupported.mockReturnValue(true);
  listPasskeys.mockResolvedValue([]);
  addPasskey.mockResolvedValue();
  removePasskey.mockResolvedValue();
});

afterEach(() => {
  listPasskeys.mockReset();
  addPasskey.mockReset();
  removePasskey.mockReset();
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

  it("一把密钥都没有时说明来路，添加成功后重取列表", async () => {
    listPasskeys.mockResolvedValueOnce([]).mockResolvedValueOnce([entry("pk-9", "手机")]);
    const { user } = renderDialog();

    expect(await screen.findByText("还没有添加通行密钥。")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "添加通行密钥" }));

    expect(addPasskey).toHaveBeenCalledOnce();
    expect(await screen.findByText("手机")).toBeInTheDocument();
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

    await user.click(await screen.findByRole("button", { name: "添加通行密钥" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("这次登录已超过一天");
  });

  it("读取失败时列表位置显示原因，添加按钮仍可用", async () => {
    listPasskeys.mockRejectedValue(new AuthRequestError("UNAUTHORIZED", "请先登录", 401));
    const { user } = renderDialog();

    expect(await screen.findByText("请先登录")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "添加通行密钥" })).toBeEnabled();
    await user.click(screen.getByRole("button", { name: "添加通行密钥" }));
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
