/** 把主题注册表写进入口 HTML 的首帧脚本。 */
// ==================== Vite 插件：首帧脚本的主题清单 ====================
// index.html 的首帧脚本在样式表与入口模块之前同步执行，无法 import 注册表；
// 合法主题与默认主题若在 HTML 里手抄一份，新增主题就得改三处、漏改一处就会把新主题当成未知值回落。
// 这里在 dev 与 build 时把两个占位换成注册表的取值，注册表仍是唯一真相源。
import path from "path";
import { fileURLToPath } from "url";
import type { Plugin } from "vite";
import { DEFAULT_THEME_ID, THEME_IDS } from "../../src/themes/Registry.ts";

export const THEME_IDS_MARKER = "__BAKAGAME_THEME_IDS__";
export const DEFAULT_THEME_MARKER = "__BAKAGAME_DEFAULT_THEME__";

const appIndexHtml = () => fileURLToPath(new URL("../../index.html", import.meta.url));

/** 纯函数，便于单测：缺任一占位就报错，宁可构建失败也不产出读不懂主题的首帧脚本。 */
export function injectThemeRegistry(
  html: string,
  ids: readonly string[] = THEME_IDS,
  fallback: string = DEFAULT_THEME_ID
): string {
  for (const marker of [THEME_IDS_MARKER, DEFAULT_THEME_MARKER]) {
    if (!html.includes(marker)) throw new Error(`index.html 的首帧脚本缺少主题占位 ${marker}`);
  }
  return html
    .replaceAll(THEME_IDS_MARKER, JSON.stringify(ids))
    .replaceAll(DEFAULT_THEME_MARKER, JSON.stringify(fallback));
}

export function themeRegistryPlugin(): Plugin {
  return {
    name: "theme-registry",
    transformIndexHtml: {
      order: "pre",
      handler(html, ctx) {
        // 只处理应用自己的入口页：Storybook 复用本配置，它的预览页没有首帧脚本。
        if (path.resolve(ctx.filename) !== appIndexHtml()) return html;
        return injectThemeRegistry(html);
      },
    },
  };
}
