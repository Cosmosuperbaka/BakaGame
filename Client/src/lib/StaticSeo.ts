/**
 * 静态外壳的清理。
 *
 * 构建期 `static-shell` 插件会把各路由的 description / canonical / robots / og 标签
 * 直接写进 HTML，让不执行 JS 的爬虫（百度为主）也能读到——这些标签带 `data-static-seo`。
 *
 * 客户端启动时必须先把它们摘掉，再由 react-helmet-async 按当前路由写入真值。原因：
 * react-helmet-async v3 在 React 19 下不再复用 DOM 里已有的标签（它按 React 元素渲染，
 * 见 client.ts 的 updateTags 只在旧路径生效），静态标签留在原地就会变成**重复标签**；
 * 搜索引擎遇到重复 canonical 会判定整组失效，比缺失更糟。
 *
 * JSON-LD 不在此列：它用固定 id，`Seo` 的 useEffect 按同一 id 覆盖内容，不会重复。
 */
export function stripStaticSeo() {
  for (const element of document.head.querySelectorAll("[data-static-seo]")) {
    element.remove();
  }
}
