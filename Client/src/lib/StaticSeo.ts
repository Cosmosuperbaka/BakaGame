/**
 * 静态外壳的清理。
 *
 * 构建期 `static-shell` 插件会把各路由的 description / canonical / robots / og 标签
 * 直接写进 HTML，让不执行 JS 的爬虫（百度为主）也能读到——这些标签带 `data-static-seo`。
 *
 * 客户端启动时必须先把它们摘掉，再由 `Seo` 按当前路由渲染真值。原因：React 19 把 `Seo`
 * 渲染的 <meta>/<link> 当作新元素插进 <head>，不会认领 DOM 里已有的同名标签，
 * 静态标签留在原地就会变成**重复标签**；搜索引擎遇到重复 canonical 会判定整组失效，比缺失更糟。
 *
 * <title> 不在此列：静态标题没有标记、不摘除。页面分块按需下载，摘掉它会让标签页在下载期间
 * 显示网址；`Seo` 挂载后改写同一个 <title> 的文字，head 里始终只有一个。
 *
 * JSON-LD 不在此列：结构化数据与 FAQPage 均用固定 id，`Seo` 的 useEffect 按同一 id 覆盖内容，不会重复。
 */
export function stripStaticSeo() {
  for (const element of document.head.querySelectorAll("[data-static-seo]")) {
    element.remove();
  }
}
