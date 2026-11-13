/** 按需生成霞鹜文楷子集并注入 fonts.css。 */
// ==================== Vite 插件：霞鹜文楷字体子集 ====================
// 源 TTF 从固定版本的上游仓库或 Release 拉取并核对 SHA-256，woff2、CSS 与清单都在
// dev / build / Storybook 启动时生成到 Git 忽略的目录。fonts.css 只留一个占位注释，
// 这里在载入时替换成真实 @font-face，避免源码 import 一个尚未生成的文件。
// 生成器按输入哈希缓存；源字体或生成脚本变化时才重新下载与分包（项目用字不参与，新增文案不会触发）。
import { type Plugin } from "vite";
import path from "path";
import fs from "fs";

const FONT_FACE_MARKER = "/* __LXGW_WENKAI_FONT_FACES__ */";
// 构建产物里的字体样式表：分块名取自源文件名 fonts.css，哈希在中间。
const FONTS_ASSET_PATTERN = /^assets\/fonts-[^/]+\.css$/;
const APP_INDEX_HTML = path.resolve(import.meta.dirname, "../../index.html");
const FONTS_CSS_PATH = path.resolve(import.meta.dirname, "../../src/fonts.css");

export function generatedFontsPlugin(): Plugin {
  let generated: Promise<{ css: string }> | undefined;
  const ensure = () => {
    if (!generated) {
      generated = import("../build-fonts.mjs")
        .then(({ ensureFonts }) => ensureFonts())
        .catch((error: unknown) => {
          generated = undefined;
          throw error;
        });
    }
    return generated;
  };

  return {
    name: "generated-fonts",
    enforce: "pre",
    async buildStart() {
      await ensure();
    },
    async configureServer() {
      await ensure();
    },
    // 生产构建：字体样式表单独成文件（入口里的动态导入让它分块），再由这里把它作为非阻塞样式表写进
    // 入口 HTML——浏览器解析 HTML 时就开始下载，不必等入口脚本执行；先以 print 媒体加载，载完切回 all。
    // 必须是后置钩子，等 Vite 排完入口自己的样式表之后再插。
    transformIndexHtml: {
      order: "post",
      handler(html, ctx) {
        // 只处理应用自己的入口页：Storybook 的预览页用静态导入引入字体样式表，没有这份分块。
        if (!ctx.bundle || path.resolve(ctx.filename) !== APP_INDEX_HTML) return html;
        const sheet = Object.keys(ctx.bundle).find((name) => FONTS_ASSET_PATTERN.test(name));
        if (!sheet) throw new Error("构建产物里找不到字体样式表，无法写入非阻塞加载标签");
        const link = `<link rel="stylesheet" crossorigin href="/${sheet}" media="print" onload="this.media = 'all'" />`;
        const anchor = html.search(/<link[^>]*rel="stylesheet"/);
        if (anchor === -1)
          throw new Error("入口 HTML 里没有样式表标签，无法确定字体样式表的插入位置");
        return `${html.slice(0, anchor)}${link}
    ${html.slice(anchor)}`;
      },
    },
    async load(id) {
      if (id.startsWith("\0")) return null;
      if (path.resolve(id.split("?")[0]) !== FONTS_CSS_PATH) return null;
      const code = await fs.promises.readFile(FONTS_CSS_PATH, "utf8");
      if (!code.includes(FONT_FACE_MARKER)) {
        throw new Error("src/fonts.css 缺少霞鹜文楷 @font-face 占位注释");
      }
      const { css } = await ensure();
      return code.replace(FONT_FACE_MARKER, css.trim());
    },
  };
}
