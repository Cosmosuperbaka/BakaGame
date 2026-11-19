import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { STORY_PROFILE } from "@/stories/fixtures/Account";
import { useAccountStore } from "@/stores/UseAccountStore";
import { AccountButton } from "./AccountEntry";

const signOut = vi.fn<() => Promise<void>>();
const originalSignOut = useAccountStore.getState().signOut;

beforeEach(() => {
  useAccountStore.setState({ status: "signedIn", profile: STORY_PROFILE, signOut });
});

afterEach(() => {
  useAccountStore.setState({ status: "loading", profile: null, signOut: originalSignOut });
  signOut.mockReset();
});

const openMenu = async () => {
  const user = userEvent.setup();
  render(
    <MemoryRouter>
      <AccountButton />
    </MemoryRouter>
  );
  await user.click(screen.getByRole("button", { name: /账号菜单/ }));
  return user;
};

describe("账号菜单", () => {
  it("退出登录失败时菜单里给出提示，按钮恢复可点，重试成功后提示消失", async () => {
    signOut.mockRejectedValueOnce(new Error("network"));
    const user = await openMenu();

    await user.click(await screen.findByRole("button", { name: "退出登录" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("退出登录失败");
    expect(screen.getByRole("button", { name: "退出登录" })).toBeEnabled();

    signOut.mockResolvedValueOnce();
    await user.click(screen.getByRole("button", { name: "退出登录" }));
    expect(signOut).toHaveBeenCalledTimes(2);
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });
});
