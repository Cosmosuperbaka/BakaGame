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
 * 标签状态放在包装组件里，切标签与打开抽屉都按真实交互走。
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

export const Changelog: Story = {
  name: "更新日志标签",
  render: () => <CreditsDemo initialTab="changelog" />,
};

export const Commits: Story = {
  name: "提交历史标签",
  render: () => <CreditsDemo initialTab="commits" />,
};

export const LicenseSheet: Story = {
  name: "许可证抽屉",
  tags: ["!page", "overlay"],
  play: async ({ canvas, userEvent }) => {
    await userEvent.click(canvas.getByRole("button", { name: /^查看 react v/ }));
    const dialog = within(await screen.findByRole("dialog", { name: "react" }));
    await dialog.findByText("LICENSE");
    dropFocus();
  },
};

export const LicenseWithoutFiles: Story = {
  name: "许可证抽屉 · 未附带原文",
  tags: ["!page", "overlay"],
  play: async ({ canvas, userEvent }) => {
    await userEvent.click(canvas.getByRole("button", { name: /^查看 left-pad v/ }));
    const dialog = within(await screen.findByRole("dialog", { name: "left-pad" }));
    await dialog.findByText("该包未附带许可证原文。");
    dropFocus();
  },
};

export const Dependencies: Story = {
  name: "依赖清单",
  // 依赖清单在三段内容的最下方，滚到它再截图：390 宽下能看到窄屏行布局与长 License 行。
  play: async ({ canvas }) => {
    canvas.getByRole("heading", { name: "依赖清单" }).scrollIntoView({ block: "start" });
    dropFocus();
  },
};

export const EmptyDependencies: Story = {
  name: "依赖清单 · 无结果",
  play: async ({ canvas, userEvent }) => {
    await userEvent.type(canvas.getByRole("searchbox", { name: "搜索依赖" }), "没有这个包");
    await canvas.findByText("没有匹配的依赖");
    dropFocus();
  },
};
