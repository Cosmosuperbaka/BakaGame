import { cleanup, render, screen, waitFor } from "@testing-library/react";
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
  badges: ["developer"],
};

afterEach(() => {
  // 先卸载再清状态：组件仍订阅账号 store，先清会让它带着已被 reset 的空 mock 再取一次资料。
  cleanup();
  clearProfileCacheForTest();
  resetAccountStoreForTest();
  publicProfile.mockReset();
});

describe("身份徽章", () => {
  it("按目录文案渲染，空列表不留占位", () => {
    const { container, rerender } = render(<BadgeList badges={[]} />);
    expect(container).toBeEmptyDOMElement();

    rerender(<BadgeList badges={["developer", "sponsor"]} />);
    expect(screen.getByText("开发者")).toBeInTheDocument();
    expect(screen.getByText("赞助")).toBeInTheDocument();
  });

  it("本人徽章直接取账号资料，不请求公开资料", async () => {
    useAccountStore.setState({ status: "signedIn", profile: ownProfile });
    render(<PlayerBadges account={{ userId: "u-self", image: null }} />);

    expect(await screen.findByText("开发者")).toBeInTheDocument();
    expect(publicProfile).not.toHaveBeenCalled();
  });

  it("他人徽章按用户 ID 读取公开资料", async () => {
    publicProfile.mockResolvedValueOnce({
      id: "u-other",
      name: "别人",
      image: null,
      qqNumber: null,
      badges: ["tester"],
    });
    render(<PlayerBadges account={{ userId: "u-other", image: null }} />);

    expect(await screen.findByText("内测")).toBeInTheDocument();
    expect(publicProfile).toHaveBeenCalledWith({ userId: "u-other" });
  });

  it("读取失败静默留空，不阻塞玩家行", async () => {
    publicProfile.mockRejectedValueOnce(new Error("offline"));
    const { container } = render(<PlayerBadges account={{ userId: "u-fail", image: null }} />);

    await waitFor(() => expect(publicProfile).toHaveBeenCalledOnce());
    await waitFor(() => expect(container).toBeEmptyDOMElement());
  });
});
