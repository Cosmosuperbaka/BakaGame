import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import path from "path";
import { commitHistoryPlugin } from "./scripts/vite-plugins/CommitHistory.ts";
import { appVersionPlugin } from "./scripts/vite-plugins/AppVersion.ts";
import { stickerManifestPlugin } from "./scripts/vite-plugins/StickerManifest.ts";
import { creditsManifestPlugin } from "./scripts/vite-plugins/CreditsManifest.ts";
import { publicWebpPlugin } from "./scripts/vite-plugins/PublicWebp.ts";
import { staticShellPlugin } from "./scripts/vite-plugins/StaticShell.ts";
import { seoArtifactsPlugin } from "./scripts/vite-plugins/SeoArtifacts.ts";
import { generatedFontsPlugin } from "./scripts/vite-plugins/GeneratedFonts.ts";
import {
  sentrySourcemapsPlugin,
  sourcemapUploadEnabled,
} from "./scripts/vite-plugins/SentrySourcemaps.ts";

export default defineConfig(({ command }) => {
  const emojiDir = path.resolve(import.meta.dirname, "./public/emojis");
  const changelogPath = path.resolve(import.meta.dirname, "./src/data/changelog.json");
  // source map 只在要上传的那次生产构建里产出（hidden：产物不带引用注释），上传后即删除。
  const uploadSourcemaps = command === "build" && sourcemapUploadEnabled(process.env);

  return {
    // publicDir 交给 public-webp 插件在 config 钩子里给出：只读取配置的工具
    // （knip）不再触发图片重转码，只有 dev server 与构建才会。
    // 图床与 /api 一样挂在后端进程上，两处都要转发：少一条 dev 环境的封面就全 404。
    server: {
      proxy: {
        "/api/bangumi": {
          target: "http://localhost:4850",
          changeOrigin: true,
        },
        // MCP 设置里的 Prompt 用页面 origin（5173），让本地 Agent 也能直接连到同一个远程 MCP；
        // 游戏 WS 也一并转发，远程 MCP 端点回连游戏服务时才不会落到 Vite 的 HTML。
        "/api": {
          target: "http://localhost:4850",
          changeOrigin: true,
          ws: true,
        },
        "/.well-known": {
          target: "http://localhost:4850",
          changeOrigin: true,
        },
      },
    },
    // E2E 跑在 vite preview（生产构建）上：客户端生产包走同源相对路径，
    // preview 站内没有后端，把 /api（含 WebSocket 升级）转发给本地 Bun 服务。
    // 本地若存在 .env（VITE_SERVER_URL 指向 4850）则客户端直连，代理不参与。
    preview: {
      proxy: {
        "/api": {
          target: "http://localhost:4850",
          changeOrigin: true,
          ws: true,
        },
        // 发现文件与 `/api` 同理：preview 站内没有后端，不转发就会退回 SPA 的 HTML，
        // E2E 断言的「JSON 可读」会假绿。
        "/.well-known": {
          target: "http://localhost:4850",
          changeOrigin: true,
        },
        // 图床前缀 `/api/bangumi` 已被上面这条 /api 规则覆盖，无需重复声明。
      },
    },
    plugins: [
      react(),
      generatedFontsPlugin(),
      tailwindcss(),
      // 只有生产构建才走远端接口：开发期读本地 git 历史，离线可用且反映当前工作区。
      commitHistoryPlugin({ useRemote: command === "build" }),
      appVersionPlugin(changelogPath),
      stickerManifestPlugin(emojiDir),
      creditsManifestPlugin(),
      publicWebpPlugin(),
      staticShellPlugin(),
      seoArtifactsPlugin(),
      uploadSourcemaps ? sentrySourcemapsPlugin(changelogPath, process.env) : [],
    ],
    build: { sourcemap: uploadSourcemaps ? "hidden" : false },
    resolve: {
      // 共享源码的运行依赖按客户端安装边界解析。独立安装的构建只在 Client 里
      // 装依赖：从 Server/src/shared 出发的裸导入必须落到这里的副本，
      // 否则打包阶段同样解析不到（与 tsconfig paths 是同一份边界的两侧）。
      dedupe: ["@sinclair/typebox", "@orpc/contract", "zod"],
      alias: [
        // 更具体的前缀必须排在前面：运行时值走 Values.ts，类型仍从 Index.ts 取。
        {
          find: "@bakagame/shared/values",
          replacement: path.resolve(import.meta.dirname, "../Server/src/shared/Values.ts"),
        },
        {
          find: "@bakagame/shared",
          replacement: path.resolve(import.meta.dirname, "../Server/src/shared/Index.ts"),
        },
        { find: "@", replacement: path.resolve(import.meta.dirname, "./src") },
      ],
    },
  };
});
