import { useState } from "react";
import type { Meta, StoryObj } from "@storybook/react-vite";
import { screen, within } from "storybook/test";
import { dropFocus } from "@/stories/PlayHelpers";
import { CreditsView, type CreditsTab } from "./CreditsView";
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
function CreditsDemo({ initialTab = "credits" }: { initialTab?: CreditsTab }) {
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
      loadLicense={loadFixtureLicense}
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

export const Credits: Story = {
  name: "开源致谢标签",
};

export const Models: Story = {
  name: "参与开发的大模型",
  play: async ({ canvas }) => {
    canvas.getByRole("heading", { name: "参与开发的大模型" }).scrollIntoView({ block: "start" });
    dropFocus();
  },
};

export const TechStack: Story = {
  name: "核心技术栈",
  play: async ({ canvas }) => {
    canvas.getByRole("heading", { name: "核心技术栈" }).scrollIntoView({ block: "start" });
    dropFocus();
  },
};

export const Dependencies: Story = {
  name: "依赖清单",
  play: async ({ canvas }) => {
    canvas.getByRole("heading", { name: "依赖清单" }).scrollIntoView({ block: "start" });
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
    await userEvent.click(dialog.getByRole("button", { name: "查看 rollup 的依赖详情" }));
    const childDialog = within(await screen.findByRole("dialog", { name: "rollup" }));
    await childDialog.findByRole("button", { name: "返回 vite" });
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

export const EmptyDependencies: Story = {
  name: "依赖清单 · 无结果",
  play: async ({ canvas, userEvent }) => {
    canvas.getByRole("heading", { name: "依赖清单" }).scrollIntoView({ block: "start" });
    await userEvent.type(canvas.getByRole("searchbox", { name: "搜索依赖" }), "没有这个包");
    await canvas.findByText("没有匹配的主包");
    dropFocus();
  },
};
