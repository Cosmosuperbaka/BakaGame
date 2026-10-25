/** 把 public 图片构建期转制 WebP 并改写引用路径。 */
import { preparePublicWebp } from "../prepare-public-webp.mjs";

export function publicWebpPlugin(prepare = preparePublicWebp) {
  let assetMap: Record<string, string> = {};

  const rewritePaths = (text: string) => {
    let transformed = text;
    for (const [sourcePath, targetPath] of Object.entries(assetMap)) {
      transformed = transformed.replaceAll(sourcePath, targetPath);
    }
    return transformed;
  };

  return {
    name: "public-webp",
    async config() {
      const prepared = await prepare();
      assetMap = prepared.assetMap;
      return { publicDir: prepared.publicDir };
    },
    configureServer(server: {
      middlewares: {
        use: (fn: (req: { url?: string }, _res: unknown, next: () => void) => void) => void;
      };
    }) {
      server.middlewares.use((req, _res, next) => {
        if (req.url) {
          const [pathname, query] = req.url.split("?");
          const target = assetMap[pathname];
          if (target) {
            req.url = target + (query ? `?${query}` : "");
          }
        }
        next();
      });
    },
    transformIndexHtml(html: string) {
      return rewritePaths(html)
        .replace(
          /<link\b([^>]*\brel=["']icon["'][^>]*\bhref=["'][^"']*\.webp["'][^>]*)>/gi,
          (match) => {
            return match.replace(/type=["']image\/[a-z0-9+]+["']/i, 'type="image/webp"');
          }
        )
        .replace(
          /<link\b([^>]*\bhref=["'][^"']*\.webp["'][^>]*\brel=["']icon["'][^>]*)>/gi,
          (match) => {
            return match.replace(/type=["']image\/[a-z0-9+]+["']/i, 'type="image/webp"');
          }
        );
    },
    transform(code: string, id: string) {
      if (id.includes("node_modules") || id.startsWith("\0")) return null;

      if (!Object.keys(assetMap).some((sourcePath) => code.includes(sourcePath))) return null;

      return {
        code: rewritePaths(code),
        map: null,
      };
    },
  };
}

// ==================== Vite 插件：静态外壳注入（可收录路由） ====================
// 本站是纯前端 SPA，构建产物的 <div id="root"> 是空的：执行 JS 的爬虫能自己渲染，
// 不执行 JS 的爬虫（百度为主）只能读到空壳。此插件在构建末尾把 PageMeta 里的正文与
// head 元信息写进各路由的 HTML，爬虫无需执行 JS 即可读到内容。
//
// 为什么是「构建期字符串注入」而不是无头浏览器预渲染：平台构建容器不提供 Chromium
// （实测报错 Executable doesn't exist ... chromium_headless_shell），而带着一个 150MB
// 的浏览器依赖去构建既慢又脆。本站可收录页面的正文本来就是数据（PageMeta），
// 直接由数据生成 HTML 更简单也更可靠。
//
// 注入的 head 标签全部带 data-static-seo="1"：这些标签只服务不执行 JS 的爬虫，
// 应用启动时会由 stripStaticSeo() 整体移除，再交给 react-helmet-async 写入当前路由的真值。
// 为什么不是「让 Helmet 接管」：react-helmet-async v3 在 React 19 下不走 DOM 复用路径
// （client.ts 里按 isEqualNode 复用旧标签的逻辑只在旧路径生效），它会直接渲染新标签，
// 静态标签留在原地就会变成重复 canonical —— 搜索引擎遇到重复 canonical 会判定整组失效。
// JSON-LD 例外：结构化数据与 FAQPage 各用一个固定 id，Seo 的 useEffect 按同一 id 覆盖内容，不产生重复。
//
// 正文外壳必须在**首次绘制之前**从执行 JS 的客户端里消失，否则用户进站会先看到一段裸文本。
// 入口是 defer 的 module 脚本（懒加载路由 chunk 还要再等一次网络），执行时机在首帧之后，
// 只靠它替换 #root 就会漏出这段文字。因此在外壳之后紧邻插入一段 parser-blocking 内联脚本，
// 随解析同步清空外壳：它被 <head> 里的渲染阻塞样式表挡住，必然早于首次绘制执行。
// 不执行 JS 的爬虫读的是原始 HTML，外壳照旧可见——两边的正文本来就是同一份。
//
// 为什么不用 `#root{display:none}` 之类的 CSS 兜底：那等于把正文标成隐藏文本，
// 在审核视角下与 hidden text 无异。此处不隐藏任何东西，只是让 JS 客户端先移除、再交给应用渲染。
// 也不用 <noscript>：目标恰恰是不执行 JS 的爬虫，而 noscript 里的内容在多数引擎眼中信号更弱。
