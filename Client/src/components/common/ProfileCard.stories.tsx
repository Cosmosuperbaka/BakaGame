import type { Meta, StoryObj } from "@storybook/react-vite";
import type { PublicProfile } from "@bakagame/shared";
import { clearProfileCacheForTest } from "@/lib/ProfileCache";
import { ProfileCard } from "./ProfileCard";

/**
 * 资料卡只在玩家行的浮层里出现，故事给它套同一层浮层外壳。
 * 资料走 `/api/rpc/account/publicProfile`：故事里桩住这一个接口，按故事给出成功、失败或一直不回。
 */
function stubProfile(reply: PublicProfile | "error" | "pending") {
  clearProfileCacheForTest();
  const original = window.fetch.bind(window);
  window.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = input instanceof Request ? input.url : String(input);
    if (!url.includes("/api/rpc/account/publicProfile")) return original(input, init);
    if (reply === "pending") return new Promise<Response>(() => {});
    if (reply === "error") throw new TypeError("Failed to fetch");
    return new Response(JSON.stringify({ json: reply, meta: [] }), {
      headers: { "content-type": "application/json" },
    });
  }) as typeof fetch;
  return () => {
    window.fetch = original;
    clearProfileCacheForTest();
  };
}

const meta = {
  title: "公共组件/ProfileCard",
  component: ProfileCard,
  args: { account: { userId: "u-story", image: null }, playerName: "小布丁" },
  render: (args) => (
    <div className="w-fit overflow-hidden floating-surface shadow-md">
      <ProfileCard {...args} />
    </div>
  ),
} satisfies Meta<typeof ProfileCard>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Ready: Story = {
  name: "正常",
  beforeEach: () =>
    stubProfile({
      id: "u-story",
      name: "小布丁",
      image: null,
      qqNumber: null,
      badges: [{ kind: "pioneer", serial: 42 }],
      equippedBadge: "pioneer",
    }),
};

/** 账号昵称与游戏昵称不同、QQ 公开、两段名字都很长：各自截断，悬停看全称。 */
export const LongInfo: Story = {
  name: "信息很长",
  args: { playerName: "房间里用的名字也起得非常非常长" },
  beforeEach: () =>
    stubProfile({
      id: "u-story",
      name: "一个账号昵称长到要截断的玩家",
      image: null,
      qqNumber: "1234567890",
      badges: [
        { kind: "contributor", serial: null },
        { kind: "pioneer", serial: 7 },
      ],
      equippedBadge: "contributor",
    }),
};

export const Loading: Story = {
  name: "加载中",
  beforeEach: () => stubProfile("pending"),
};

/** 网络失败退回通用文案；「重试」是 ghost 小按钮，与资料卡其余文字同一层级。 */
export const Failed: Story = {
  name: "加载失败",
  beforeEach: () => stubProfile("error"),
};
