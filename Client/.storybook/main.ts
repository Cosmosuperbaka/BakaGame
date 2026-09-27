import type { StorybookConfig } from "@storybook/react-vite";
import type { Plugin, PluginOption } from "vite";

// 只在生产构建里有意义、会改写 dist/ 的插件，以及读实时 git 数据、会让截图随每次提交变化的插件。
// Storybook 复用 vite.config.ts 时把它们剔除；提交历史改由下方的固定数据提供。
const EXCLUDED_PLUGINS = new Set(["static-shell", "commit-history"]);

async function withoutExcludedPlugins(plugins: PluginOption[] = []): Promise<PluginOption[]> {
  const resolved = await Promise.all(plugins);
  const kept: PluginOption[] = [];
  for (const plugin of resolved) {
    if (Array.isArray(plugin)) kept.push(...(await withoutExcludedPlugins(plugin)));
    else if (!plugin || !("name" in plugin) || !EXCLUDED_PLUGINS.has(plugin.name)) kept.push(plugin);
  }
  return kept;
}

const HOUR = 3_600_000;
const STORY_COMMITS: Array<[string, string, number]> = [
  ["a1c3e5f", "feat(CCB): 大厅对齐其它游戏", 2],
  ["b2d4f60", "refactor(Core): 抽取公共大厅组件", 5],
  ["c3e5071", "fix(Song): 修复倒计时提前归零", 26],
  ["d4f6182", "style(Core): 统一三游戏设计语言", 49],
  ["e5a7293", "feat(Faker): 新增发言历史展开", 73],
  ["f6b83a4", "docs(Core): 校正部署链路指引", 170],
];

/**
 * 提交历史的固定数据：哈希与文案固定，时间以预览加载时刻为基准，
 * 相对时间文案（几小时前、几天前）每次截图都一致，不随真实仓库变化。
 */
function storyCommitHistory(): Plugin {
  const id = "virtual:commit-history";
  return {
    name: "story-commit-history",
    enforce: "pre",
    resolveId: (source) => (source === id ? `\0${id}` : null),
    load(source) {
      if (source !== `\0${id}`) return null;
      return `const now = Date.now();
export default {
  generatedAt: new Date(now).toISOString(),
  currentCommit: "a1c3e5f",
  commits: ${JSON.stringify(STORY_COMMITS)}.map(([hash, message, hoursAgo]) => ({
    hash, message, author: "BakaGame", date: new Date(now - hoursAgo * ${HOUR}).toISOString(),
  })),
};`;
    },
  };
}

// 公共资源不走 staticDirs：vite.config.ts 已把 publicDir 指向构建期生成的 WebP 目录，
// Storybook 合并该配置后由 Vite 自己托管，WebP 路径映射插件同样生效。
const config: StorybookConfig = {
  stories: ["../src/**/*.stories.tsx"],
  framework: { name: "@storybook/react-vite", options: {} },
  core: { disableTelemetry: true, disableWhatsNewNotifications: true },
  async viteFinal(viteConfig) {
    return {
      ...viteConfig,
      plugins: [storyCommitHistory(), ...(await withoutExcludedPlugins(viteConfig.plugins))],
      // 故事按需加载，首次用到的依赖若未预构建，Vite 会中途重新优化并让在途请求返回 504。
      optimizeDeps: {
        ...viteConfig.optimizeDeps,
        include: [
          ...(viteConfig.optimizeDeps?.include ?? []),
          "@radix-ui/react-dialog", "@radix-ui/react-label", "@radix-ui/react-popover", "@radix-ui/react-scroll-area",
          "@radix-ui/react-select", "@radix-ui/react-separator", "@radix-ui/react-slider", "@radix-ui/react-slot",
          "@radix-ui/react-switch", "@radix-ui/react-tabs", "@radix-ui/react-tooltip",
          "framer-motion", "react-router-dom", "zustand",
        ],
      },
    };
  },
};

export default config;
