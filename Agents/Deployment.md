# 生产部署边界

仅在修改部署、代理、公开基址、静态外壳或缓存时读取对应章节；普通业务修改不需要通读发布流程。

| 工作范围 | 查阅章节 |
|---|---|
| TLS、WS 接入、基址或探活 | 「反向代理职责」「请求链路与同源化边界」 |
| SEO 与构建期 HTML | 「前端静态外壳」 |
| 资源缓存及响应头 | 「边缘缓存策略」 |
| 服务端发布或部署脚本 | 「持续部署流水线」及时间预算、R2 数据分发、Secrets 小节 |
| 快照或容量 | 「带宽与容量基线」与 [Testing](Testing.md#验证范围) |

本文描述配置与验收要求，不授权执行部署、重启或线上写探针；按用户已授权范围完成本地验证和发布准备。示例公网地址使用 `example.com` 占位，实际地址从部署配置取得。

WhoIsFaker、Songuessr 与 CEE 的实时业务分别通过 `/api/whoisfaker/ws`、
`/api/songuessr/ws` 和 `/api/cee/ws` 提供。应用服务负责 WebSocket
协议解析、业务权限和房间状态，并在握手升级阶段按来源地址占名额（`transport/WsHandshakeQuota.ts`，
默认单地址 64 条在途连接、每分钟 120 次新建、全局每分钟 3000 次、窗口 60 秒，超限回 `RATE_LIMITED`）。
这道配额是回源之后的兜底，桶键取自 `resolveClientIp` 的来源身份，伪造该标头自造新桶由回源 peer 的十倍额度封顶，
不能代替公开入口的速率与带宽保护；反向代理仍必须独立限制单来源的握手速率、请求速率、并发连接数与帧大小。
公开遥测与 Sentry 隧道另有应用内资源预算，同样不能代替入口保护；其来源信任边界见下文。

## 反向代理职责

生产环境必须在公开入口的反向代理或边缘网关配置以下保护：

- 终止 TLS，并只向公网暴露 HTTPS/WSS。
- 限制单个来源的握手速率、请求速率和并发 WebSocket 连接数。
- 限制 HTTP 请求体、WebSocket 消息或帧大小以及连接带宽。
- 配置空闲连接和握手超时，同时允许正常对局使用长连接。
- 正确转发 WebSocket 的 `Upgrade` 与 `Connection` 头。
- 不得在代理层注入或强制启用 `permessage-deflate`；应用为兼容 iOS WebKit 全局关闭该扩展。
- 只把受信任的前端来源转发给服务；应用的 `CLIENT_URL` 必须与该来源一致。

具体数值应按部署平台容量和真实流量确定，并由平台监控验证。没有完成上述入口保护时，
不得把 Bun 服务端口直接暴露到公网。

公开遥测 `/api/monitoring/telemetry` 与 Sentry 隧道 `/api/monitoring/sentry` 的客户端身份，
由 `Server/src/transport/ClientIp.ts` 统一解析：优先采信 ESA 托管转换在回源请求上写入的
真实客户端 IP 标头（控制台 `RealClientIpHeaderName`，当前 `X-Real-IP`，`ali-real-client-ip` 兜底），
且值必须能解析成 IP 字面量；否则退回 Bun `server.requestIP(request)` 的 peer。
`X-Forwarded-For` 可被客户端任意伪造，任何场景都不参与分桶。限流是三层桶：
单客户端 60/min、回源 peer 600/min（封顶伪造标头自造新桶）、全局 1000/min；
无 socket 的请求共享 unknown 桶。**标头名是 ESA 控制台与代码的双侧契约**，
任一侧改名必须同批发布，否则会静默退回 peer 桶、全体客户端重新挤回同一个桶。
ESA 节点地址并非安全边界：源站端口若可被直连，转发头仍可伪造，因此 peer 桶与全局桶必须保留。

### 服务端出站：NapCat 内网入口

QQ 昵称查询是**服务端出站**调用，不经过边缘与公网：NapCat 与 BakaGame 同 VPC，
NapCat 侧 nginx 只开一个 `location /onebot-internal/`（`proxy_pass` 到宿主 `127.0.0.1:6700`，
`allow` 只列 BakaGame 宿主内网 IP、其余 `deny all`），BakaGame 容器经 compose 的
`extra_hosts` 把 `napcat.baka.website` 指向 NapCat 内网地址——TLS/SNI 与证书照常匹配，
流量不出内网。OneBot 端口不映射到公网，也不新增边缘路由：1Panel 默认防火墙只放行
80/443/SSH，新端口会被 `1PANEL_BASIC_AFTER` 直接 DROP。

### 服务端出站：图片与头像抓取

`CEEImageHints`（角色图提示）、`BangumiImageService`（图床回源）与 `QQAvatarService`（qlogo 头像）
三条出站链路统一经 `Server/src/infrastructure/OutboundGuard.ts`：

- **永不自动跟随跳转**：请求固定 `redirect: "manual"`，跳转由本模块逐跳处理，最多 3 跳，超限即失败并释放响应体。
- **不可信地址逐跳复核**：数据集与上游协议里的图片地址属于第三方数据，每一跳都要重过
  `assertOutboundUrl`——只允许 http(s)、禁止 URL 内嵌凭据、拒绝回环/私网/链路本地（含 `169.254.169.254`
  元数据服务）/CGNAT/组播与保留段、拒绝 `localhost` 家族与无点单标签主机。
- **可信基址只锁同源**：`BANGUMI_IMAGE_SOURCE` 与 qlogo 由运维配置，属可信输入，只要求跳转不离开该源，
  避免为了护栏把内网反代基址也判死。

残余风险与部署前提：以上判定基于主机名与字面量地址，**公开 DNS 名解析到内网（含 DNS rebinding）不在
应用层能力内**。容器出网必须在网络层收敛（安全组/iptables 只放行图片与音频上游所需的公网网段，
显式 DROP 到 VPC 内网与元数据地址），NapCat 这类内网入口不得成为被抓取的可达目标。

## 请求链路与同源化边界

**浏览器必须跨域直连后端公开域名**，后端以 Origin 白名单和 CORS 响应。后端公开域名仍可经过站点加速层；不能把“跨域”理解为绕过 CDN 直连源站 IP。

同源 `/api/*` 反代不可用：握手可以返回 `101`，但后续 WebSocket 数据帧不会转发。前端域名的 `/api/*` 会落入 SPA HTML 兜底，不能用作后端健康探针。

### 客户端基址

解析逻辑以 [ServerEndpoint.ts](../Client/src/lib/ServerEndpoint.ts) 为准：

| 场景 | `VITE_SERVER_URL` | 结果 |
|---|---|---|
| 本地开发 | `http://localhost:4850` | 直连本地后端 |
| 生产 | 后端公开 HTTPS 基址 | 跨域直连，必须显式配置 |
| 生产留空，或显式 `/`、`same-origin` | 同源相对路径 | 解析器支持，但代理链路无法转发 WS，生产不得使用 |

只有目标平台明确支持 WS 转发，且在目标环境验证“握手 → 命令 → 对应 ACK”后，才可重新引入同源代理并切换基址。先验证链路，再切换配置；仅 `101` 或 HTTP 成功不满足条件。

### 边缘验证的适用范围

以下约束用于避免重复踩坑：

- Makers `rewrite()` 支持跨域绝对地址，但本地 `makers dev` 缺少边缘注入的 fetch，无法验证这一能力；本地 502 不能直接代表线上结果。
- middleware `/api/:path*` matcher 先于 SPA fallback，相似前缀 `/apiish` 不匹配。站点加速的 zone 级边缘函数不能拦截 Makers 托管域名。
- 只验证 HTTP GET/POST、CDN 响应头及 SPA fallback 不足以证明反代可用；WS 握手成功后的数据转发才是判据。`200 + HTML` 表示反代未生效，是另一种故障。
- Makers 项目使用 GitHub 集成，由远端 main 更新触发构建，CLI 不能直传部署。常规发布使用本机签名提交与 push；REST contents 提交会丢失 SSH 签名，不作为常规替代。

### 探针与完成条件

- 对后端公开基址请求 `/health`、`/livez`、`/readyz`，核对状态码与 JSON 内容，不能只接受 HTTP 200（首页 HTML 也可能是 200）。
- HTTP 代理验证使用已知只读 GET 端点，并检查响应体和 `x-trace-id`。不得用标签提交等 POST 写接口探测连通性。
- WS 验证连接后发送只读大厅订阅等命令并检查关联 ACK；可能创建房间或改变对局的命令使用隔离本地实例。
- 生产目标的检查仅在已有授权范围内运行。只修改文档不触发线上探针；既有验证结论不能替代本次发布证据。

## 前端静态外壳 (Static Shell)

前端是纯前端 SPA，构建产物的 `<div id="root">` 默认是空的：执行 JS 的爬虫能自行渲染，
不执行 JS 的爬虫（百度为主）只能读到空壳，收录无从谈起。构建末尾由 `vite.config.ts` 的
`static-shell` 插件把 `Client/src/data/PageMeta.ts` 里的正文与 head 元信息写进各路由的 HTML，
爬虫无需执行 JS 即可读到内容。

- **零浏览器依赖**：插件是纯 Node 字符串注入。**不要改回无头浏览器预渲染**——平台构建容器
  不提供 Chromium，让构建去下载浏览器既慢又脆；本站可收录页面的正文本来就是数据，由数据生成 HTML 更可靠。
- **文案单一真相源**：`PageMeta.ts` 同时被页面组件的 `Seo`（运行时写 head）与插件（构建期写 HTML）
  消费，改了描述两处一起变。页面侧调用因此简化为 `<Seo path="/" />`；未登记的路径（房间页、
  单人页）必须显式传 `description`，否则组件当场抛错。
- 新增开放大厅须同步 `PageMeta`（含每页 FAQ 问答与结构化数据）、主页游戏介绍与链接、资源冒烟和
  SEO E2E（站点地图由构建期从 `PageMeta` 生成，无需手改；分享图素材放 `public/assets` 同名文件）；
  运行时 `description` 与 `og:description` 必须读取同一份解析后的文案。房间页保持 `noindex`，并在
  `robots.txt` 排除对应房间路径，CEE 的增强房与原版房共用 `/cee/room/` 规则。
- 落点（双形态，不赌主机的静态解析规则）：`dist/index.html`、
  `dist/<route>/index.html`（目录索引型主机）、`dist/<route>.html`（clean URL 型主机）。
  别名与正式路径内容一致，重复内容由 canonical 收敛，别名不进 sitemap。
- **站点地图与分享图随构建生成**：`dist/sitemap.xml` 与 `dist/og/*.jpg` 由 `seo-artifacts` 插件在
  构建末尾产出。站点地图的 URL 集合与 `lastmod` 取自 `PageMeta`——`lastmod` 只在页面文案或结构
  显著变更时更新、不随构建刷新；分享图从
  `public/assets` 的同名源图转 jpg（全站图片管线只产 webp，而 QQ 等分享抓取器不认 webp，
  卡片显示不出图），`PageMeta.image` 一律写 `${SITE_ORIGIN}/og/<名>.jpg`，外链图原样放行。
- **FAQ 与组织实体结构化数据**：每页的常见问答（`PageMeta.faq`）由构建期写进静态外壳正文并派生
  FAQPage JSON-LD，运行时 `Seo` 按固定 id 重建同一份数据；问答随外壳在首帧前一起清空，用户不可见。
  缺问答、空条目或重复问题会让构建直接失败——这块内容坏了没有观感反馈，只能靠断言拦在部署前。
  首页 WebSite 结构化数据内含 Organization 实体（`sameAs` 指向 `REPOSITORY_URL`），用于 AI 搜索的实体识别。
- **正文外壳必须在首次绘制之前消失**：外壳插在 `#root` 内，紧随其后是一段 parser-blocking
  内联脚本 `document.getElementById("root").replaceChildren()`，随解析同步清空。入口是 defer 的
  module 脚本（懒加载路由 chunk 还要再等一次网络），执行时机在首帧之后——只靠它替换 `#root`，
  用户进站会先看到一段未排版的裸文本。**不要改成 `#root{display:none}` 之类的
  CSS 兜底**：那等于把正文标成隐藏文本，与 hidden text 同类；此处不隐藏任何东西，只是让
  JS 客户端先移除、再交给应用渲染。**也不要用 `<noscript>`**：目标恰恰是不执行 JS 的爬虫，
  noscript 内容在多数引擎眼中信号更弱。不执行 JS 的爬虫读的是原始 HTML，外壳照旧可见——
  两边本来就是同一份正文。
- **静态标签必须在客户端启动时摘掉**：注入的 head 标签带 `data-static-seo="1"`，
  `Client/src/lib/StaticSeo.ts` 的 `stripStaticSeo()` 在入口模块（`Main.tsx`）里把它们整体移除，
  再由 react-helmet-async 按当前路由写入真值。**不要改成「让 Helmet 接管静态标签」**——
  react-helmet-async v3 在 React 19 下不走 DOM 复用路径（复用旧标签的逻辑只在旧路径生效），
  它会直接渲染新标签，静态标签留在原地就变成重复 canonical——搜索引擎判定整组失效，比缺失更糟。
  JSON-LD 例外：结构化数据与 FAQPage 各用一个固定 id（`bakagame-structured-data` 与
  `bakagame-faq-structured-data`），`Seo` 的 useEffect 按同一 id 覆盖内容，不重复。
- 不注入的页面：房间页与单人页——内容由服务端实时状态驱动，没有可静态化的正文，且已标 `noindex`。
- 自校验：插件在注入点缺失或产物缺少标记时直接让构建失败；`scripts/asset-smoke.mjs` 逐路由断言
  外壳存在（无浏览器，跑在 CI 的 client job）；「有没有产生重复标签」由 E2E 用真实浏览器断言
  （strict 定位器遇到重复标签会直接报错）。
- 生产构建命令：平台的 Makers 项目是 GitHub 集成型，构建在平台侧发生，`npm run build` 即可
  （静态外壳已在 build 内完成）。`build:seo` 只是指向 `build` 的兼容别名，新配置一律用 `npm run build`。
- **构建期有一次只读的 GitHub 接口请求**（`commit-history` 插件取公开仓库的提交历史）：
  构建容器是浅克隆（depth=1），`git log` 只有 HEAD 一条，页脚弹窗的提交列表因此改由接口提供，
  并用本次构建的提交作 `sha` 起点，保证列表第一条与 `meta[name=bakagame-build]` 是同一个提交。
  请求失败（限流、超时、离线、该提交尚未推送都会 4xx/超时）一律降级为该容器内的 git 历史，
  **不得让构建失败**；3 秒超时是硬上限，构建耗时预算按 ≤3s 计。
  需要更高配额时在构建环境注入 `GITHUB_TOKEN`，未配置也能跑（未认证额度按出口 IP 每小时 60 次，
  远高于构建频率）。
- 上线验收：用 `curl`（不带 JS）访问 `/`、`/whoisfaker`、`/songuessr`、`/cee` 四个路由，正文应含对应文案且 canonical 指向自身。
  若平台把游戏大厅回退成了首页外壳，说明静态文件未被解析，
  先检查静态产物与平台路由解析；不要因此引入同源 API/WS 中间件。静态路径规则与实时反代分别验证。

## 边缘缓存策略 (edgeone.json)

`Client/edgeone.json` 是前端响应头与边缘缓存的**唯一真相源**。它是纯数据文件：写错了没有
类型检查、没有构建报错，只会在线上表现为「发版后老用户拿到旧页面」或「静态资源反复回源」。
`Client/src/lib/EdgeCacheConfig.test.ts` 把下面的约定固化成了断言，改错当场失败。

### 分档原则：有没有内容哈希

**缓存时长的唯一判据是「这个文件名会不会随内容变化」，不是「它是什么类型的文件」。**
Vite 产物带 8 位内容哈希（`.js` / `.css` / 字体），内容一变文件名就变，缓存一年也安全；
而 `public/` 下的图片经 `prepare-public-webp.mjs` 转码后**保留原名**（站点图、favicon 等）。
给后者发 `immutable` 等于把换图能力锁死——文件名不变，浏览器与边缘都不会再回源。

| 路径 | Cache-Control | 边缘 TTL | 理由 |
|---|---|---|---|
| `/api/*` | `no-store` | 0 | 实时接口，缓存即错 |
| `/assets/*.{js,css,woff2,woff,ttf}` | `max-age=31536000, immutable` | 1 年 | 内容哈希，永不复用旧名 |
| `/stickers/*` | `max-age=31536000, immutable` | 1 年 | 文件名即内容摘要（见 `stickerAssetUrl`） |
| `/emojis/*` | `max-age=86400` | 1 天 | 保留原名的兼容路径，无哈希 |
| `/assets/*.{webp,png,jpg,jpeg,gif,svg}` | `max-age=604800` | 7 天 | 含 5 个无哈希固定名图片，**不得 immutable** |
| `/sitemap.xml`、`/robots.txt` | `max-age=3600` | 1 小时 | 内容稳定但需可更新 |
| 其余（含全部 HTML 外壳） | `max-age=0, must-revalidate` | — | SPA 外壳不带哈希，长缓存会卡住发版 |

### 规则顺序：具体在前，兜底垫底

平台的 `headers` 与 `caches` **按书写顺序取首个命中，不按精确度排序**。
`/*` 必须排在**最后**：它一旦前置就会吞掉后面所有具体规则，而 JSON 依然合法、平台也照常
接受，故障是静默的（`/api/*` 的 `no-store` 会被 `/*` 完全屏蔽）。
测试里用「探测路径必须拿到自己那档策略」锁死了这一点。

### headers 与 caches 必须同档

`Cache-Control` 的 `max-age` 与 `caches[].cacheTtl` 描述同一个保鲜期：前者约束浏览器，
后者约束边缘。只改一处会让两侧对同一资源的判断分裂，排查时极难定位，必须成对修改
（测试逐条比对两者相等）。

### 缓存与路由分别验证

`edgeone.json` 的 `/api/*` 规则只声明不缓存，不创建代理路由。请求链路、健康探针和同源切换条件见前文；缓存头正确不能证明业务请求到达后端。

发布时按实际部署基址检查三档资源：

```bash
curl -sI https://game.example.com/assets/index-<hash>.js  # 一年 + immutable
curl -sI https://game.example.com/assets/logo.webp        # 七天，无 immutable
curl -sI https://game.example.com/                       # max-age=0, must-revalidate
curl -s https://backend.example.com/health               # 后端 JSON，不是 HTML
curl -s https://backend.example.com/readyz               # ready 为 true
```

其中 `<hash>` 从本次构建获取。前端 `/api/*` 的 no-store 可单独检查，但不得要求 SPA 兜底响应携带后端 `x-trace-id`。

## 应用职责

应用仍必须校验每个命令的结构、身份、权限、阶段和业务数据。代理层的资源保护不能替代
`Server/src/transport/WhoIsFakerProtocol.ts` 与 `WhoIsFakerService`（及 `SonGuessrService`、`CEEService`）的业务校验；应用校验也不能替代代理层的
来源限流和资源配额。

### 安全响应头由应用侧统一注入

`Server/src/transport/SecurityHeaders.ts` 在 `onRequest` 一次性写入 `nosniff`、`X-Frame-Options: DENY`、
`Referrer-Policy: no-referrer`、`Permissions-Policy`、`Cross-Origin-Opener-Policy` 与
`Content-Security-Policy: default-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'`，
再经全局 `mapResponse` 补到 Better Auth、oRPC、头像与图床字节流这些自建 `Response` 上。
逐条路由自己加头一定会漏，登记一次才覆盖得全。三条口径：

- **`/openapi` 只放宽 CSP**：Swagger UI 要跑内联脚本与外部资源，`default-src 'none'` 会把文档页打死，
  因此该路径只保留 `frame-ancestors`/`base-uri`/`form-action` 三条，其余收紧项（含 `nosniff`）照旧。
  放宽的是文档页自己的资源加载，不是 API 响应。
- **HSTS 只在确实走了 TLS 时回**：TLS 由边缘终结，容器内是明文 HTTP，明文连接收到该头浏览器会忽略。
  判定用 `x-forwarded-proto` 的第一段，值取不带 `includeSubDomains` 的保守值，只覆盖后端自己的域；
  站点主域的 HSTS 仍由边缘负责。
- **边缘不得剥离这些头**：代理只允许追加，不允许改写或删除；若边缘另有一份 CSP，以应用侧更严格值为基线核对，
  避免出现「应用收紧、边缘又放开」的静默回退。

听歌猜番还需要在服务端配置 `BANGUMI_API_URL`（可选再配 `BANGUMI_IMAGE_SOURCE` 让图床缺图自愈）。
该地址只允许由服务端访问；客户端不得直连 Bangumi，代理也不得把 `lain.bgm.tv` 原始图片地址暴露
给浏览器 —— 图片对外前缀**写死**为自建图床 `/api/bangumi`（不可配，见 [Conventions](Conventions.md#6-环境变量规范-environment-variables)），
**前提是代理层把 `/api/*` 转发到后端**。发布前应验证镜像支持 `/v0/search/subjects`
与 `/v0/subjects/{id}`，并确认图片保留原始路径、查询参数和片段。

## 带宽与容量基线

实时状态采用带修订号的增量同步，首次连接、重连、修订缺口和周期校准才发送全量。
生产发布前必须运行 `bun test test/NetworkCapacity.test.ts`；其固定验收目标是单台
6 Mbps 出口承载 150 名 WhoIsFaker 玩家，并在每秒 12 次房间变化与每分钟一次全量校准下
保留 15% 的 TLS/TCP/IP 传输余量。代理的带宽监控应按应用出口持续核对这一预算；超过预算时
优先检查新增快照字段、重复事件和广播频率，不得通过取消最终同步或延长到不可接受的状态延迟来过测。

同一预算的可复现测量在 `Server/scripts/loadtest/`：`bun run scripts/loadtest/Harness.ts --mode ramp|cap|fat`
用与生产同一条 `createApp` 装配线（数据源换桩、出口守卫 preload）拉起独立被测进程，`--mix faker=..,song=..,cee=..`
调三款游戏的玩家占比，`--mbps` 把出口钉在预算内反解玩家数，`bun run scripts/loadtest/Report.ts` 把多次运行合成一份 HTML。
两条从测量里定下来的口径：

- **人均带宽要按节奏取窗口**：慢节奏下一局要跑一分多钟，25 秒窗口会整段落在低流量阶段，把人均带宽低估数倍、
  让带宽二分收敛到读数噪声。测量窗口必须覆盖一个完整回合（`Harness.ts` 按 `pace` 自适应，pace 1 取 90 秒）。
- **房间号只有四位数字**：同一个被测进程里跨步骤复用号段时，要先等上一步遗留的空房被房务清掉
  （空房宽限 90 秒 + 10 秒房务节拍），否则整批开局撞号，测到的吞吐只剩一部分房间。

## 隔离启动与交付回归

- `ProductionSmoke.ts` 与 Playwright 后端共用 `scripts/IsolatedServer.ts`：禁用 Bun `.env` 自动加载、环境白名单、清空遥测/账号与数据库连接、临时 enrichment、自有子进程退出竞赛及仅 preload 注入的随机所有者端点；烟测使用独立端口。Playwright 后端与 preview 都不复用现有服务。
- 仅测试 preload 阻断主动 fetch、WebSocket、Node TCP/TLS/HTTP/DNS/UDP 与 Bun.connect/udpSocket，拒绝派生进程并向 Worker 传播守卫；真实第三方测试另行授权，不通过增加重试或放开出口修复测试。该守卫不是操作系统沙箱，不承诺隔离原生扩展或未纳入守卫的新网络 API；常规夹具不得调用这些出口。
- 离线 `bun --no-env-file test scripts/Delivery.test.ts` 覆盖门禁反例、移动分支与固定 SHA、退出假绿、所有者标记、临时目录回收、合成环境与出口拒绝；不运行正式 Index。真实 E2E 的外部图片/音乐需求应由专用 Provider 夹具接替，不可重新放开网络。`ClientCiFilter.mjs` 在 client CI 使用已安装的 picomatch 跑路径反例；Python 构建夹具在普通 PR CI 独立执行，无下载和数据提交。

## 持续部署流水线

触发条件与实际命令以 [deploy.yml](../.github/workflows/deploy.yml) 和 [ci.yml](../.github/workflows/ci.yml) 为准：

- 自动发布由 main 的 `CI` 工作流完成事件触发；gate 要求整体 CI 成功，且 `Server CI` 作业实际执行并成功。客户端或文档改动使服务端作业跳过时，不自动部署后端。
- `Server/**` 与部署脚本自身必须保留在 CI 的服务端路径过滤范围，保证修改发布脚本也经过门禁。
- 部署消费 CI 结果，不在 deploy 中重复跑一遍完整测试。手动 `workflow_dispatch` 必须提供 `ci_run_id`，与自动路径共用门禁：同仓库 `main` 的 push、整体 CI 完成且成功、实际 `Server CI` 成功；缺失、失败、取消、跳过或 PR run 均不放行。执行仍需发布授权。
- 前端 Makers 的 main 推送可能独立触发构建；“不部署后端”不代表推送没有任何生产影响。

### 容器运行环境前置条件

以下变量必须在**容器创建时**注入运行环境（compose `environment`/`env_file` 或 `docker run -e`）。
容器内以 `--no-env-file` 运行的步骤（release 元数据、停机通知、就绪探针）只读创建时环境，
不读任何 `.env` 文件；`docker restart` 保留旧环境，补注入必须重建容器。发布前逐项核对：

| 变量 | 缺失后果 | 要求 |
|---|---|---|
| `MAINTENANCE_TOKEN` | 停机通知步骤中止，部署不重启（安全失败） | 自洽随机串，`openssl rand -hex 32` 生成；trim 后非空且不含换行 |
| `DEPLOYMENT_ENVIRONMENT=production` | 遥测 / Sentry 环境标记静默记为 development | 显式设为 production 时**启动强制要求 `MEILISEARCH_KEY`**，否则服务拒绝启动；未设置时按 NODE_ENV → development 解析（优先级见 [Conventions](Conventions.md#运行环境标记与资产验证隔离)）。Meilisearch 就绪前不要设 production |
| `MEILISEARCH_KEY` | 搜索降级为本地 FTS/LIKE 与官方回退（无 Meilisearch 增强） | 与 Meilisearch master key 一致；网络前提见下节；首次启用涉及索引构建，须单独验证，不与其它变更同批 |
| `MEILISEARCH_URL` | 独立 Meili 容器下回环地址不可达：搜索与出题链路初始化失败（**不降级**，不可用） | Meili 与 app 同网络命名空间时可不设（默认 `http://127.0.0.1:7700`）；独立容器设为容器可达地址（如 `http://<meili 容器名>:7700`），与 `MEILISEARCH_KEY` 同批核对 |
| `CCB_ORIGINAL_SERVER_URL` + `CCB_ORIGINAL_AES_SECRET` | 原版兼容房不提供入口（可控降级） | 两者都非空才启用 |
| `DATABASE_URL` | `DEPLOYMENT_ENVIRONMENT=production` 时服务拒绝启动 | TiDB 连接串，必须带库名；新环境首启后在容器内执行一次 `bun run db:import-word-bank` 导入词库，见 [Database](Database.md) |
| `BETTER_AUTH_SECRET` | 配置 `DATABASE_URL` 时服务拒绝启动 | 至少 32 字符随机串，`openssl rand -hex 32` 生成；更换会使全部登录会话失效 |
| `SMTP_HOST` + `SMTP_USER` + `SMTP_PASS`（`SMTP_PORT`、`MAIL_FROM` 选填） | `DEPLOYMENT_ENVIRONMENT=production` 时服务拒绝启动 | 飞书企业邮箱为 `smtp.feishu.cn:465`，`SMTP_PASS` 用邮箱客户端专用密码；生产不得设 `MAIL_DEV_CONSOLE`，见 [Account](Account.md#9-配置) |
| `SENTRY_API_TOKEN` | 后台概览的 Sentry 卡片显示「未配置」（可控降级） | 专用只读令牌（`org:read`、`project:read`、`event:read`），不复用个人全权令牌 |

存在性自查（只计数、不打印值）：

```bash
sudo docker inspect BakaGame --format '{{range .Config.Env}}{{println .}}{{end}}' \
  | grep -cE '^(MAINTENANCE_TOKEN|DEPLOYMENT_ENVIRONMENT|MEILISEARCH_KEY|MEILISEARCH_URL|CCB_ORIGINAL_SERVER_URL|CCB_ORIGINAL_AES_SECRET|DATABASE_URL|BETTER_AUTH_SECRET|SMTP_HOST|SMTP_USER|SMTP_PASS)='
```

完整生产配置输出 11，未启用原版房时为 10（`SMTP_PORT`、`MAIL_FROM`、`ADMIN_QQ` 为选填，不计入）。缺 `MAINTENANCE_TOKEN` 部署必中止；独立 Meili 容器下缺 `MEILISEARCH_URL` 为搜索链路故障（见上表）；其余项按上表降级。

### 发布链路与失败边界

CEE 与 SonGuessr 搜索的生产前提：预先运行 Meilisearch，并确保 `BakaGame` 容器与它共享网络空间、
可从容器内访问 `127.0.0.1:7700`；单独的默认桥接容器的 `localhost` 不指向另一个容器。
Meilisearch 的 master key 与服务端 `MEILISEARCH_KEY` 必须一致，原版房的
`CCB_ORIGINAL_AES_SECRET` 独立配置。现有部署流水线只重启 `BakaGame`，不安装或启动搜索服务；
前提未满足时不得发布该搜索配置。

1. SSH 使用 `appleboy/ssh-action`，`script_stop: false`，由脚本 `set -euo pipefail` 管理失败；作业与 SSH 命令均限 3 分钟。
2. 门禁输出获验 run ID 与完整 40 位 SHA；远端 `/BakaGame` fetch/reset 该 SHA，并核验 HEAD 一致（不消费移动 main）。数据实体不随代码分发：部署**绝不搬走、绝不覆盖**服务器上的数据库（数据集与图床由运维一次性上传、此后由后端自行更新）；仅在服务器没有可用数据库且 manifest 提供 `dataset` 条目时按下一节规则补发。这是部署环境操作，不在本地开发工作区照抄 `reset --hard`。
3. 数据校验后、排空前生成获验修订的 release 元数据，流程及失败边界见下一节；宿主机不需要 Node/Bun。
4. 排空前通过容器内 `DeploymentNotify.ts` 调用本机 `POST /api/system/notify-shutdown`，从生产容器环境读取 `MAINTENANCE_TOKEN` 并以 Bearer 鉴权，不使用自报 `X-Real-IP`、不打印 token、不放入命令参数。Token 是只在容器内部自洽的随机共享密钥，不与任何外部系统交换，用 `openssl rand -hex 32` 生成即可（唯一格式约束：trim 后非空、不含换行）；必须在容器创建时通过运行环境显式注入（只在容器内 `.env` 提供不足以供 `--no-env-file` helper 消费，且 `docker restart` 不更新环境——补注入需重建容器）。缺失、非成功状态或 3 秒超时均中止部署且不重启，不声称预通知成功。接口向三款游戏广播并摘除 readiness。
5. 等待 3 秒排空，重启 `BakaGame` 容器；容器入口负责依赖同步与服务拉起。
6. 在总计 30 秒预算内检查本机 `/health`、`/livez`、`/readyz` 的 `ready:true` 与三款游戏订阅 ACK（不创建房间）。通过 `docker exec -i` 将目标 SHA 的只读 `DeploymentProbe.ts` 送入容器 Bun，不猜测挂载路径，不加载应用或 `.env`。失败打印容器末尾日志、作业失败，不报部署成功；重启后不自动二次重启或回滚，由运维依据日志与获验 SHA 恢复。

### 发布元数据与遥测验收

- reset 获验 SHA 并核对 `COMMIT == DEPLOY_REV`、数据库校验完成后，维护通知/重启前生成 `Server/build/release.json`。只允许 schemaVersion、完整 40 位小写 revision 与 changelog 的最新稳定 semver 三个字段，不含环境变量、凭据或私有端点；`.gitignore` 忽略整个 `Server/build`。
- 元数据逻辑由 `Server/src/infrastructure/Release.ts` 唯一维护：宿主用 `docker exec -i` 把该获验修订的源文件经 stdin 送入**已存在**的容器 Bun，以 `--no-env-file -` 运行；SHA 和该修订的公开 changelog JSON 作为两个参数传入。仅导入标准库，不加载应用/SDK，不要求宿主安装 Node/Bun，不猜测容器中的源码挂载路径。
- 宿主先用 `mktemp` 在目标 build 目录创建临时文件，容器 stdout 写入该文件；退出成功后将其设为可读的 0644 并同目录 `mv` 原子替换。无效/缺失 SHA、损坏 JSON、无稳定版本、脚本异常或 3 秒截止均中止发布、不进入维护通知及容器重启，旧元数据不被截断，临时文件由失败分支/退出陷阱清理。Linux 宿主须通过现有环境自检提供 `cat/chmod/timeout`。
- 运行时以模块位置定位 Server/仓库根，真实根 Git HEAD 与 changelog 优先，拒绝当前工作目录、父仓库及继承 GIT_DIR/GIT_WORK_TREE 导致的错误修订；无根 Git 时校验 metadata。生成后的 build 目录必须随 Server 的现有挂载/部署进入容器；无有效证据返回 `undefined` 并在 Sentry 启用时提示，不以硬编码旧版本或任意环境字符串冒充 release。canonical 格式为 `Vx.y.z（hash）`，完整 SHA 只在元数据保留，展示 hash 统一 7 位。
- 环境解析优先级及 development 缺省见 [Conventions](Conventions.md#运行环境标记与资产验证隔离)，生产必须显式注入 production；Sentry 与 OTLP 使用同一标记。`Server/test/Release.test.ts` 执行真实 stdin 元数据脚本及从 workflow 提取的原子落盘阶段，Docker/sudo 在临时目录模拟，不重启真实容器；配套 Env/Sentry 测试均无真实遥测写入。
- 本地测试通过不等于线上 release 流量已经正确。部署后须按 SDK、实例、environment 与 canonical release 复核 producer，并区分历史日志；本文与本地测试不声称已替换生产实例或删除旧事件。

### 时间预算铁律

生产服务器位于中国大陆，出境链路质量不可控。`deploy` 作业的每一段都必须落在预算内，
**任何新的部署步骤都要先声明它占用的秒数**，否则不得合入：

| 阶段 | 预算 |
|---|---|
| runner 准备 + SSH 建连 | ≤ 15s |
| `git fetch` + `reset` + 数据库校验 | ≤ 10s |
| 数据下载（仅数据变更时才发生） | 受 `DL_DEADLINE` 约束；为从脚本开始起 115s 的绝对截止，包含此前耗时 |
| release 元数据生成与原子落盘 | ≤ 3s（容器元数据脚本由 `timeout 3s` 约束） |
| 客户端排空 | ≤ 3s |
| 运维 Bearer 通知 | ≤ 3s |
| 容器重启 | ≤ 5s |
| 健康检查 | ≤ 30s |

下载截止时间与其他阶段预算有重叠，不能把表内数字直接相加。整体仍须满足 3 分钟硬超时。**常态部署（数据未变）应在 60s 内完成**，
这是目标值而非上限：数据下载路径必须设计成"无事发生"。

### 数据分发（可选；只用于基线补发）

`Server/data/bangumi.sqlite` **不进 Git**：Git LFS 会吃穿账户的带宽额度。**投递方式**：一份「基线」数据集由运维一次性上传（图床目录
`Server/data/images/` 直接上服务器；数据集另发一份到 R2 供 CI 取用），此后由后端自行更新
（标签刷新、新条目发现、每日备份）；CI 不构建也不发布数据集。

部署脚本只保留一条**基线补发**通路：服务器上**没有**可用数据库时（首启/灾备重建），若 manifest
提供了 `dataset` 条目则按版本化 URL 下载并校验落位；**服务器已有的库绝不搬走、绝不替换**——它与
清单的 sha256 几乎必然不同（后端在持续更新）。无清单时完全跳过网络。发布基线与本地更新链路见
[Server/data/README.md](../Server/data/README.md)：

- **一致性锚点只有 manifest**：`<CDN 基址>/files/bangumi/manifest.json`（公开、ESA 禁缓存）
  记录当前版本的 `object / sha256 / size`。runner 在部署前解析出版本化 URL、sha256、size，
  经 SSH `envs` 传参（`BG_DATA_*`）——**生产机全程不接触 R2 凭证**，
  也不许现场解析 manifest 或猜测版本化对象名。
- **传参先做格式校验**：URL（HTTPS + 白名单字符）、sha256（64 位小写十六进制）、size（正整数）
  任一不合规即中止，防 SSH envs 注入。
- **已有的库绝不触碰**：工作区的库不进暂存区、不参与下载比对——后端在持续更新它，部署对它唯一的
  动作是「校验为有效 SQLite」。只有完全缺失时才走补发；指针文本（LFS 时代残留）一律丢弃，
  绝不能被当作数据库搬动。
- **下载 = 8 路分片并行 + 全局截止**：`SPLIT=8`、`DL_DEADLINE=115s`（自脚本起的绝对截止，
  包含此前全部耗时）。每片 `curl -r` 带连接/总超时、`--speed-limit/--speed-time` 空转放弃与
  `--retry 2 --retry-delay 1`（R2 同为 Cloudflare 前置，对并发突发可能 403/429，排查先看
  状态码再调超时）；**逐分片长度自校验**（防忽略 `Range` 直接回整文件的中间层），合并后
  整体 sha256 兜底。
- **断点续传**：分片目录按「文件名 + 目标 sha256 前缀」命名并跨运行保留（失败清理只删
  `.probe` / `.merged.*`，不动 `.parts.*`）；一次跑不完，重跑接着下，不从零开始。
  分片临时路径必须由文件名派生——多个数据文件是并行下载的，bash 的 `$$` 在子 shell 中仍是父进程
  PID，用它拼路径会让两个任务互相覆盖，产出体积正确但内容错乱的文件。
- **失败必须不重启容器、不留坏数据**：下载失败 / 落盘校验失败都在 `docker restart` 之前中止；
  `trap on_exit` 把暂存区的旧库放回工作区，防止下一次容器重启读到缺失或损坏的数据库。
  worktree 里若出现 LFS 指针文本（历史失败运行遗留）直接丢弃——**只有魔数 `SQLite format 3`
  的文件才允许进暂存区，绝不能用 `mv -f` 让无效文件覆盖唯一的真实数据库**。
- **保留 LFS 双保险**：脚本 `export GIT_LFS_SKIP_SMUDGE=1` 并
  `git config --local filter.lfs.required false`，防服务器旧克隆的残留配置在 reset 时去拉实体。
- **任何失败必须带行号喊出来**：脚本 `set -E` +
  `trap 'echo "❌ 第 ${LINENO} 行失败：$BASH_COMMAND"' ERR`，每阶段打印检查点
  （目标 sha256/大小、复用还是下载）。静默失败会让排查成本翻十倍——一次部署只有 3 分钟，
  没有第二次机会慢慢猜。
- **开工先做环境自检**：`git/curl/awk/sort/tr/wc/head/basename/sha256sum/date/grep/cp/mv/rm/mktemp/cat/chmod/timeout`
  逐个 `command -v`，缺哪个就报名字退出。生产机环境不受本仓库控制，不要假设它齐全。

实体不从 GitHub 取；不得为防止 LFS 出境下载而恢复「LFS 镜像 / raw 代理 / 多节点测速」那套复杂度。

### GitHub Secrets 密钥配置规范

严禁将真实服务器凭据提交至代码库。部署与数据发布链路依赖以下 GitHub Repository Secrets：

| Secret 名称 | 说明 | 示例/默认值 |
|---|---|---|
| `DEPLOY_HOST` | 生产服务器 IP 地址或域名 | 必填 |
| `DEPLOY_PORT` | SSH 端口号 | 未设置时默认 `22` |
| `DEPLOY_USER` | SSH 登录用户名 | `ubuntu`（未设置时默认 `ubuntu`） |
| `DEPLOY_KEY` | 用于 SSH 鉴权的私钥纯文本 | 必填（完整包含 BEGIN/END 标记） |
| `DEPLOY_PASSPHRASE` | 用于解密 SSH 私钥的密码（若私钥受密码保护） | 可选（私钥无密码保护时无需配置） |
| `BANGUMI_DATA_CDN_BASE` | R2 加速域基址（公开），CI 与部署据此解析基线 manifest | 必填（只读消费，不含凭证） |
| `R2_ACCESS_KEY_ID` | R2 S3 兼容 Access Key | 无仓库内使用方（本地发布脚本自备凭证） |
| `R2_SECRET_ACCESS_KEY` | R2 S3 兼容 Secret Key | 无仓库内使用方 |
| `R2_S3_ENDPOINT` | R2 S3 API 端点 | 无仓库内使用方 |
| `R2_BUCKET` | R2 桶名 | 无仓库内使用方 |

R2 凭证四件套没有仓库内使用方（本地发布脚本
`tools/publish_bangumi_data.py` 用自己环境的变量，不进仓库）；CI 与生产部署只按公开 URL
下载版本化对象，生产机不持有任何 R2 凭证。
