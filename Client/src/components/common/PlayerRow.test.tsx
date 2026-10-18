import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { PublicProfile } from "@/types";
import { clearProfileCacheForTest } from "@/lib/ProfileCache";
import { PlayerRow } from "./PlayerRow";

const publicProfile = vi.hoisted(() =>
  vi.fn<(input: { userId: string }) => Promise<PublicProfile>>()
);

vi.mock("@/lib/Api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/Api")>()),
  api: { account: { publicProfile } },
}));

afterEach(() => {
  clearProfileCacheForTest();
  publicProfile.mockReset();
});

describe("PlayerRow 资料卡", () => {
  it("游客且无操作权限时整行不可点", () => {
    render(<PlayerRow name="游客" score={0} />);
    expect(screen.queryByRole("button")).not.toBeInTheDocument();
  });

  it("登录玩家显示账号头像，点开资料卡：账号昵称与游戏昵称分开写，QQ 号默认不公开", async () => {
    const user = userEvent.setup();
    publicProfile.mockResolvedValue({
      id: "u1",
      name: "阿狸",
      image: "/api/account/avatar/u1?v=1",
      qqNumber: null,
    });
    const { container } = render(
      <PlayerRow
        name="房间里的名字"
        score={3}
        account={{ userId: "u1", image: "/api/account/avatar/u1?v=1" }}
      />
    );

    expect(container.querySelector("img")?.getAttribute("src")).toContain(
      "/api/account/avatar/u1?v=1"
    );
    await user.click(screen.getByRole("button", { name: "房间里的名字 资料" }));
    expect(await screen.findByText("阿狸")).toBeInTheDocument();
    expect(screen.getByText("游戏昵称 房间里的名字")).toBeInTheDocument();
    expect(screen.getByText("QQ 号未公开")).toBeInTheDocument();
    expect(publicProfile).toHaveBeenCalledWith({ userId: "u1" });
  });

  it("本人公开 QQ 时显示号码；同一访问内再次打开不重复请求", async () => {
    const user = userEvent.setup();
    publicProfile.mockResolvedValue({ id: "u2", name: "小艾", image: null, qqNumber: "10001" });
    render(
      <PlayerRow
        name="小艾"
        score={0}
        account={{ userId: "u2", image: null }}
        actions={[{ icon: null, label: "踢出玩家", onClick: () => {} }]}
      />
    );

    const trigger = screen.getByRole("button", { name: "小艾 操作" });
    await user.click(trigger);
    expect(await screen.findByText("10001")).toBeInTheDocument();
    expect(screen.queryByText(/游戏昵称/)).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "踢出玩家" })).toBeInTheDocument();

    await user.keyboard("{Escape}");
    await user.click(trigger);
    expect(await screen.findByText("10001")).toBeInTheDocument();
    expect(publicProfile).toHaveBeenCalledOnce();
  });

  it("资料读取失败时就地提示，可直接重试", async () => {
    const user = userEvent.setup();
    publicProfile.mockRejectedValueOnce(new Error("offline"));
    publicProfile.mockResolvedValueOnce({
      id: "u3",
      name: "重试成功",
      image: null,
      qqNumber: null,
    });
    render(<PlayerRow name="某人" score={0} account={{ userId: "u3", image: null }} />);

    const trigger = screen.getByRole("button", { name: "某人 资料" });
    await user.click(trigger);
    expect(await screen.findByRole("alert")).toHaveTextContent("资料加载失败");

    await user.click(screen.getByRole("button", { name: "重试" }));
    expect(await screen.findByText("重试成功")).toBeInTheDocument();
    expect(publicProfile).toHaveBeenCalledTimes(2);
  });
});
