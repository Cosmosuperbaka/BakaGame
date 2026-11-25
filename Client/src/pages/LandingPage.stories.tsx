import type { Meta, StoryObj } from "@storybook/react-vite";
import { OPEN_SITE_FEATURES } from "@bakagame/shared/values";
import { resetSiteFeaturesForTest, type SiteFeatures } from "@/lib/SiteConfig";
import { STORY_PROFILE, presetAccount } from "@/stories/fixtures/Account";
import LandingPage from "./LandingPage";

/**
 * 主页本身不再承载版本信息浮层：页脚的版本号是一个导航入口，
 * 点击后进入完整页面 `/abouts`（更新日志 / 提交历史 / 开源致谢 / 法务子页），
 * 各标签的展示在「页面/版本信息」的故事里单独截图。
 */
const meta = {
  title: "页面/主页",
  component: LandingPage,
  tags: ["page"],
  parameters: { layout: "fullscreen" },
} satisfies Meta<typeof LandingPage>;

export default meta;
type Story = StoryObj<typeof meta>;

/**
 * 静态 Storybook 没有后端：只桩站点配置这一个接口，其余请求照常放行。
 * 返回值在全开的基础上叠加 `patch`，故事结束时还原 fetch 与配置缓存。
 */
function stubSiteFeatures(patch: Partial<SiteFeatures> = {}): () => void {
  resetSiteFeaturesForTest();
  const original = window.fetch.bind(window);
  window.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = input instanceof Request ? input.url : String(input);
    if (!url.includes("/api/site/config")) return original(input, init);
    return new Response(JSON.stringify({ ...OPEN_SITE_FEATURES, ...patch }), {
      headers: { "content-type": "application/json" },
    });
  }) as typeof fetch;
  return () => {
    window.fetch = original;
    resetSiteFeaturesForTest();
  };
}

export const Default: Story = { name: "默认" };

/**
 * 已登录且有未读回复：顶栏的账号入口换成头像，头像与反馈各带一枚红点。
 * 窄屏顶栏三个入口同为图标钮，和站名排在同一行。
 */
export const SignedIn: Story = {
  name: "已登录 · 有未读回复",
  beforeEach: () => {
    const restoreAccount = presetAccount({
      status: "signedIn",
      profile: STORY_PROFILE,
      unreadFeedback: 2,
    });
    const restoreFeatures = stubSiteFeatures();
    return () => {
      restoreFeatures();
      restoreAccount();
    };
  },
};

/** 后台临时关掉部分模式：入口留在原位、置灰并标注「暂时关闭」。 */
export const ModesClosed: Story = {
  name: "部分模式暂时关闭",
  beforeEach: () =>
    stubSiteFeatures({ fakerEntry: false, songSoloEntry: false, ceeRankedEntry: false }),
};
