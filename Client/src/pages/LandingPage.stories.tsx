import type { Meta, StoryObj } from "@storybook/react-vite";
import { OPEN_SITE_FEATURES } from "@bakagame/shared/values";
import { resetSiteFeaturesForTest } from "@/lib/SiteConfig";
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

export const Default: Story = { name: "默认" };

/**
 * 后台临时关掉部分模式：入口留在原位、置灰并标注「暂时关闭」。
 * 这里只桩站点配置一个接口，其余请求照常放行。
 */
export const ModesClosed: Story = {
  name: "部分模式暂时关闭",
  beforeEach: () => {
    resetSiteFeaturesForTest();
    const original = window.fetch.bind(window);
    window.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = input instanceof Request ? input.url : String(input);
      if (!url.includes("/api/site/config")) return original(input, init);
      const body = {
        ...OPEN_SITE_FEATURES,
        fakerEntry: false,
        songSoloEntry: false,
        ceeRankedEntry: false,
      };
      return new Response(JSON.stringify(body), {
        headers: { "content-type": "application/json" },
      });
    }) as typeof fetch;
    return () => {
      window.fetch = original;
      resetSiteFeaturesForTest();
    };
  },
};
