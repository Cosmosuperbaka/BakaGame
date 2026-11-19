import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AccountProfile, PublicProfile } from "@bakagame/shared";
import { clearProfileCacheForTest } from "@/lib/ProfileCache";
import { resetAccountStoreForTest, useAccountStore } from "@/stores/UseAccountStore";
import { BadgeList, PlayerBadges } from "./BadgeList";

const publicProfile = vi.hoisted(() =>
  vi.fn<(input: { userId: string }) => Promise<PublicProfile>>()
);

vi.mock("@/lib/Api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/Api")>()),
  api: { account: { publicProfile } },
}));

const ownProfile: AccountProfile = {
  id: "u-self",
  name: "自己",
  qqNumber: "12345",
  image: null,
  showQq: false,
  role: "user",
  createdAt: "2026-10-01T00:00:00.000Z",
  badges: [
    { kind: "contributor", serial: null },
    { kind: "pioneer", serial: 7 },
  ],
  equippedBadge: "pioneer",
};

afterEach(() => {
  // 先卸载再清状态：组件仍订阅账号 store，先清会让它带着已被 reset 的空 mock 再取一次资料。
  cleanup();
  clearProfileCacheForTest();
  resetAccountStoreForTest();
  publicProfile.mockReset();
});

describe("身份徽章", () => {
  it("按目录文案与注册序号渲染，悬停给出描述", async () => {
    const user = userEvent.setup();
    const { container, rerender } = render(<BadgeList badges={[]} />);
    expect(container).toBeEmptyDOMElement();

    rerender(
      <BadgeList
        badges={[
          { kind: "contributor", serial: null },
          { kind: "pioneer", serial: 42 },
        ]}
      />
    );
    expect(screen.getByText("贡献者")).toBeInTheDocument();
    expect(screen.getByText("先行者·№42")).toBeInTheDocument();

    await user.hover(screen.getByText("贡献者"));
    expect(await screen.findByRole("tooltip")).toHaveTextContent("为BakaGame做出卓越贡献的玩家");
  });

  it("玩家行只展示佩戴中的一枚徽章；本人不请求公开资料", async () => {
    useAccountStore.setState({ status: "signedIn", profile: ownProfile });
    render(<PlayerBadges account={{ userId: "u-self", image: null }} />);

    expect(await screen.findByText("先行者·№7")).toBeInTheDocument();
    expect(screen.queryByText("贡献者")).not.toBeInTheDocument();
    expect(publicProfile).not.toHaveBeenCalled();
  });

  it("他人徽章按用户 ID 读取公开资料，也只取佩戴中的一枚", async () => {
    publicProfile.mockResolvedValueOnce({
      id: "u-other",
      name: "别人",
      image: null,
      qqNumber: null,
      badges: [
        { kind: "contributor", serial: null },
        { kind: "pioneer", serial: 9 },
      ],
      equippedBadge: "contributor",
    });
    render(<PlayerBadges account={{ userId: "u-other", image: null }} />);

    expect(await screen.findByText("贡献者")).toBeInTheDocument();
    expect(screen.queryByText("先行者·№9")).not.toBeInTheDocument();
    expect(publicProfile).toHaveBeenCalledWith({ userId: "u-other" });
  });

  it("读取失败静默留空，不阻塞玩家行", async () => {
    publicProfile.mockRejectedValueOnce(new Error("offline"));
    const { container } = render(<PlayerBadges account={{ userId: "u-fail", image: null }} />);

    await waitFor(() => expect(publicProfile).toHaveBeenCalledOnce());
    await waitFor(() => expect(container).toBeEmptyDOMElement());
  });
});
