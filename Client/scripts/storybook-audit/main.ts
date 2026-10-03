import path from "node:path";
import type { StorybookConfig } from "@storybook/react-vite";

const client = path.resolve(import.meta.dirname, "../..");
const stories = [
  "src/pages/WhoIsFakerRoomPage.stories.tsx",
  "src/components/songuessr/phases/SongGameStage.stories.tsx",
  "src/components/songuessr/lyrics/SongLyricPlayer.stories.tsx",
].map((file) => path.join(client, file).replaceAll("\\", "/"));

// 专项 dev 验证：显式复用无资源生成器的 Vite 配置，不加载主 vite.config.ts。
const config: StorybookConfig = {
  stories,
  framework: { name: "@storybook/react-vite", options: {
    builder: { viteConfigPath: path.join(client, "e2e/SongLyrics.vite.ts") },
  } },
  core: { disableTelemetry: true, disableWhatsNewNotifications: true },
  async viteFinal(vite) {
    return {
      ...vite,
      root: client,
      publicDir: false,
      cacheDir: path.join(client, "node_modules/.vite-storybook-audit"),
      define: { ...vite.define,
        "import.meta.env.VITE_SENTRY_DSN": JSON.stringify(""),
        "import.meta.env.VITE_SERVER_URL": JSON.stringify("http://127.0.0.1:4850"),
      },
      optimizeDeps: { ...vite.optimizeDeps, entries: stories, include: [
        ...(vite.optimizeDeps?.include ?? []), "framer-motion", "react-router-dom", "zustand",
        "@radix-ui/react-dialog", "@radix-ui/react-tooltip", "@radix-ui/react-scroll-area",
        "@radix-ui/react-select", "@radix-ui/react-popover", "@radix-ui/react-slider",
      ] },
      plugins: [...(vite.plugins ?? []), {
        name: "isolated-story-data",
        resolveId(id) { return id === "virtual:commit-history" || id === "virtual:sticker-manifest" ? `\0${id}` : null; },
        load(id) {
          if (id === "\0virtual:commit-history") return 'export default { generatedAt: "", currentCommit: "story-audit", commits: [] }';
          if (id === "\0virtual:sticker-manifest") return 'export default { packs: [] }';
          return null;
        },
      }],
    };
  },
};
export default config;
