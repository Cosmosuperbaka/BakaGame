import { useState } from "react";
import type { Meta, StoryObj } from "@storybook/react-vite";
import { screen, within } from "storybook/test";
import { dropFocus } from "@/stories/PlayHelpers";
import { CreditsView, type CreditsTab, type CreditsViewProps } from "./CreditsView";
import {
  CREDITS_FIXTURE_CHANGELOG,
  CREDITS_FIXTURE_COMMITS,
  CREDITS_FIXTURE_DEPENDENCIES,
  CREDITS_FIXTURE_MODELS,
  CREDITS_FIXTURE_TECH_STACK,
  loadFixtureLicense,
} from "./CreditsFixtures";

/**
 * 展示层故事：直接注入夹具，不 import `virtual:credits`。
 * 标签状态放在包装组件里，切标签、打开抽屉与下钻都按真实交互走。
 */
function CreditsDemo({
  initialTab = "credits",
  loadLicense = loadFixtureLicense,
}: {
  initialTab?: CreditsTab;
  loadLicense?: CreditsViewProps["loadLicense"];
}) {
  const [tab, setTab] = useState<CreditsTab>(initialTab);
  return (
    <CreditsView
      tab={tab}
      onTabChange={setTab}
      onBack={() => {}}
      versionLabel="V1.2.0"
      commitLabel="3ee6998"
      dependencies={CREDITS_FIXTURE_DEPENDENCIES}
      models={CREDITS_FIXTURE_MODELS}
      techStack={CREDITS_FIXTURE_TECH_STACK}
      changelogEntries={CREDITS_FIXTURE_CHANGELOG}
      commits={CREDITS_FIXTURE_COMMITS}
      loadLicense={loadLicense}
    />
  );
}

const meta = {
  title: "页面/开源致谢",
  component: CreditsView,
  tags: ["page"],
  parameters: { layout: "fullscreen" },
  // meta 先把必填入参补齐，stories 只覆盖自己关心的交互；真实渲染仍由 render 里的包装组件驱动。
  args: {
    tab: "credits",
    onTabChange: () => {},
    onBack: () => {},
    versionLabel: "V1.2.0",
    commitLabel: "3ee6998",
    dependencies: CREDITS_FIXTURE_DEPENDENCIES,
    models: CREDITS_FIXTURE_MODELS,
    techStack: CREDITS_FIXTURE_TECH_STACK,
    changelogEntries: CREDITS_FIXTURE_CHANGELOG,
    commits: CREDITS_FIXTURE_COMMITS,
    loadLicense: loadFixtureLicense,
  },
  render: () => <CreditsDemo />,
} satisfies Meta<typeof CreditsView>;

export default meta;
type Story = StoryObj<typeof meta>;

/**
 * 把标签内容区滚到某个标题处。只滚标签自己的滚动容器：`scrollIntoView` 会连带滚动
 * 所有祖先（外壳 overflow-hidden 也算），顶栏与标签栏会被推出视口，截图不是玩家看到的样子。
 */
function scrollPanelTo(heading: HTMLElement) {
  const panel = heading.closest<HTMLElement>("[role='tabpanel']");
  if (!panel) return;
  panel.scrollTop +=
    heading.getBoundingClientRect().top - panel.getBoundingClientRect().top - 16;
}

export const Credits: Story = {
  name: "开源致谢标签",
};

export const Models: Story = {
  name: "参与开发的大模型",
  play: async ({ canvas }) => {
    scrollPanelTo(canvas.getByRole("heading", { name: "参与开发的大模型" }));
    dropFocus();
  },
};

export const Thanks: Story = {
  name: "特别鸣谢",
  play: async ({ canvas }) => {
    scrollPanelTo(canvas.getByRole("heading", { name: "特别鸣谢" }));
    dropFocus();
  },
};

export const TechStack: Story = {
  name: "核心技术栈",
  play: async ({ canvas }) => {
    scrollPanelTo(canvas.getByRole("heading", { name: "核心技术栈" }));
    dropFocus();
  },
};

export const Dependencies: Story = {
  name: "依赖清单",
  play: async ({ canvas }) => {
    scrollPanelTo(canvas.getByRole("heading", { name: "依赖清单" }));
    dropFocus();
  },
};

/** 隐私说明：法务长文的标题层级、信息项（来源 / 用途）与列表节奏。 */
export const Privacy: Story = {
  name: "隐私说明标签",
  render: () => <CreditsDemo initialTab="privacy" />,
};

/** 隐私说明滚到第三方服务：无序列表与列表项里的加粗名称。 */
export const PrivacyThirdParty: Story = {
  name: "隐私说明 · 第三方服务",
  render: () => <CreditsDemo initialTab="privacy" />,
  play: async ({ canvas }) => {
    scrollPanelTo(canvas.getByRole("heading", { name: "二、第三方服务" }));
    dropFocus();
  },
};

/** 用户条款：开头的风险提示框与正文各节。 */
export const Terms: Story = {
  name: "用户条款标签",
  render: () => <CreditsDemo initialTab="terms" />,
};

/** 用户条款滚到末尾几节：长文收尾的留白与最后一节。 */
export const TermsEnd: Story = {
  name: "用户条款 · 末尾",
  render: () => <CreditsDemo initialTab="terms" />,
  play: async ({ canvas }) => {
    scrollPanelTo(canvas.getByRole("heading", { name: "六、免责与责任限制" }));
    dropFocus();
  },
};

export const Changelog: Story = {
  name: "更新日志标签",
  render: () => <CreditsDemo initialTab="changelog" />,
};

export const Commits: Story = {
  name: "提交历史标签",
  render: () => <CreditsDemo initialTab="commits" />,
};

/** 抽屉打开时许可证区默认折叠，正文区只有包身份、跳转按钮与依赖构成。 */
export const DependencyDrawer: Story = {
  name: "依赖抽屉 · 默认折叠",
  tags: ["!page", "overlay"],
  play: async ({ canvas, userEvent }) => {
    await userEvent.click(canvas.getByRole("button", { name: /^查看 react v/ }));
    const dialog = within(await screen.findByRole("dialog", { name: "react" }));
    await dialog.findByText("许可证原文");
    dropFocus();
  },
};

/** 展开许可证原文后的抽屉：加载完成后展示包自带的 LICENSE / NOTICE。 */
export const DependencyLicense: Story = {
  name: "依赖抽屉 · 许可证展开",
  tags: ["!page", "overlay"],
  play: async ({ canvas, userEvent }) => {
    await userEvent.click(canvas.getByRole("button", { name: /^查看 react v/ }));
    const dialog = within(await screen.findByRole("dialog", { name: "react" }));
    await userEvent.click(dialog.getByRole("button", { name: "许可证原文" }));
    await dialog.findByText("LICENSE");
    dropFocus();
  },
};

/** 子依赖下钻：返回按钮与子依赖列表同屏，验证二级结构。 */
export const DependencyDrilldown: Story = {
  name: "依赖抽屉 · 子依赖下钻",
  tags: ["!page", "overlay"],
  play: async ({ canvas, userEvent }) => {
    await userEvent.click(canvas.getByRole("button", { name: /^查看 vite v/ }));
    const dialog = within(await screen.findByRole("dialog", { name: "vite" }));
    // 行的可访问名带版本与 License（「查看 rollup v4.48.0（MIT，开发依赖）的依赖详情」），按前缀找。
    await userEvent.click(dialog.getByRole("button", { name: /^查看 rollup v/ }));
    const childDialog = within(await screen.findByRole("dialog", { name: "rollup" }));
    await childDialog.findByRole("button", { name: "返回上一层" });
    dropFocus();
  },
};

/** 未附带许可证原文的主包：展开后给出缺失说明，不显示空的原文块。 */
export const DependencyWithoutLicense: Story = {
  name: "依赖抽屉 · 未附带原文",
  tags: ["!page", "overlay"],
  play: async ({ canvas, userEvent }) => {
    await userEvent.click(canvas.getByRole("button", { name: /^查看 left-pad v/ }));
    const dialog = within(await screen.findByRole("dialog", { name: "left-pad" }));
    await userEvent.click(dialog.getByRole("button", { name: "许可证原文" }));
    await dialog.findByText("该包未附带许可证原文。");
    dropFocus();
  },
};

/** 许可证原文读取中：加载器一直不回，折叠区里只有转圈与说明。 */
export const DependencyLicenseLoading: Story = {
  name: "依赖抽屉 · 许可证读取中",
  tags: ["!page", "overlay"],
  render: () => <CreditsDemo loadLicense={() => new Promise(() => {})} />,
  play: async ({ canvas, userEvent }) => {
    await userEvent.click(canvas.getByRole("button", { name: /^查看 react v/ }));
    const dialog = within(await screen.findByRole("dialog", { name: "react" }));
    await userEvent.click(dialog.getByRole("button", { name: "许可证原文" }));
    await dialog.findByText("正在读取许可证原文…");
    dropFocus();
  },
};

/** 许可证原文读取失败：错误说明与「重试」。 */
export const DependencyLicenseFailed: Story = {
  name: "依赖抽屉 · 许可证读取失败",
  tags: ["!page", "overlay"],
  render: () => <CreditsDemo loadLicense={() => Promise.reject(new Error("offline"))} />,
  play: async ({ canvas, userEvent }) => {
    await userEvent.click(canvas.getByRole("button", { name: /^查看 react v/ }));
    const dialog = within(await screen.findByRole("dialog", { name: "react" }));
    await userEvent.click(dialog.getByRole("button", { name: "许可证原文" }));
    await dialog.findByRole("button", { name: "重试" });
    dropFocus();
  },
};

export const EmptyDependencies: Story = {
  name: "依赖清单 · 无结果",
  play: async ({ canvas, userEvent }) => {
    scrollPanelTo(canvas.getByRole("heading", { name: "依赖清单" }));
    await userEvent.type(canvas.getByRole("searchbox", { name: "搜索依赖" }), "没有这个包");
    await canvas.findByText("没有匹配的主包");
    dropFocus();
  },
};
