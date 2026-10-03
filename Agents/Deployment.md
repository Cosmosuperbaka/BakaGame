# 生产部署边界

仅在修改部署、代理、公开基址、静态外壳或缓存时读取对应章节；普通业务修改不需要通读发布流程。

| 工作范围 | 查阅章节 |
|---|---|
| TLS、WS 接入、基址或探活 | 「反向代理职责」「当前请求链路与同源化边界」 |
| SEO 与构建期 HTML | 「前端静态外壳」 |
| 资源缓存及响应头 | 「边缘缓存策略」 |
| 服务端发布或部署脚本 | 「持续部署流水线」及时间预算、LFS、Secrets 小节 |
| 快照或容量 | 「带宽与容量基线」与 [Testing](Testing.md#验证范围) |

本文描述配置与验收要求，不授权执行部署、重启或线上写探针；按用户已授权范围完成本地验证和发布准备。示例公网地址使用 `example.com` 占位，实际地址从部署配置取得。

WhoIsFaker、Songuessr 与 CCB 的实时业务分别通过 `/api/whoisfaker/ws`、
`/api/songuessr/ws` 和 `/api/ccb/ws` 提供。应用服务负责 WebSocket
协议解析、业务权限和房间状态，不在进程内按来源 IP 实现游戏握手限流或连接配额。
公开遥测与 Sentry 隧道另有应用内资源预算，不能代替入口保护；其来源信任边界见下文。

## 反向代理职责

生产环境必须在公开入口的反向代理或边缘网关配置以下保护：

- 终止 TLS，并只向公网暴露 HTTPS/WSS。
- 限制单个来源的握手速率、请求速率和并发 WebSocket 连接数。
- 限制 HTTP 请求体、WebSocket 消息或帧大小以及连接带宽。
- 配置空闲连接和握手超时，同时允许正常对局使用长连接。
- 正确转发 WebSocket 的 `Upgrade` 与 `Connection` 头。
- 不得在代理层注入或强制启用 `permessage-deflate`；应用当前为兼容 iOS WebKit 全局关闭该扩展。
- 只把受信任的前端来源转发给服务；应用的 `CLIENT_URL` 必须与该来源一致。

具体数值应按部署平台容量和真实流量确定，并由平台监控验证。没有完成上述入口保护时，
不得把 Bun 服务端口直接暴露到公网。

公开遥测 `/api/telemetry` 与 Sentry 隧道 `/api/monitoring/sentry` 的应用内单来源预算，
只使用 Bun `server.requestIP(request)` 的传输 peer；不信任客户端自报的
`X-Forwarded-For` / `X-Real-IP`。经反向代理时全体客户端共享代理 peer 桶，
无 socket 的请求共享 unknown 桶；当前没有 authenticated-forwarding，不能称为每玩家 IP 限流。
独立总预算仍启用。若生产需要细分代理后来源，须先明确并验证受信代理身份与转发头覆盖规则；
不能仅解析任意转发头。当前聚合桶容量须结合真实代理流量验收。

## 当前请求链路与同源化边界

**当前配置要求是浏览器跨域直连后端公开域名**，后端以 Origin 白名单和 CORS 响应。后端公开域名仍可经过站点加速层；不能把“跨域”理解为绕过 CDN 直连源站 IP。

`Client/middleware.js` 的同源 `/api/*` 反代已经撤销：历史验证中握手可返回 `101`，但后续 WebSocket 数据帧没有被转发。前端域名的 `/api/*` 会落入 SPA HTML 兜底，不能用作后端健康探针。

### 客户端基址

解析逻辑以 [ServerEndpoint.ts](../Client/src/lib/ServerEndpoint.ts) 为准：

| 场景 | `VITE_SERVER_URL` | 结果 |
|---|---|---|
| 本地开发 | `http://localhost:4850` | 直连本地后端 |
| 当前生产配置 | 后端公开 HTTPS 基址 | 跨域直连，必须显式配置 |
| 生产留空，或显式 `/`、`same-origin` | 同源相对路径 | 解析器支持，但当前代理链路不具备使用条件 |

只有目标平台明确支持 WS 转发，且在目标环境验证“握手 → 命令 → 对应 ACK”后，才可重新引入同源代理并切换基址。先验证链路，再切换配置；仅 `101` 或 HTTP 成功不满足条件。

### 历史边缘验证的适用范围

以下是 2026-09 的实验记录，用于避免重复踩坑，不代表当前线上已启用：

- Makers `rewrite()` 曾验证支持跨域绝对地址，但本地 `makers dev` 缺少边缘注入的 fetch，无法验证这一能力；本地 502 不能直接代表线上结果。
- middleware `/api/:path*` matcher 先于 SPA fallback，相似前缀 `/apiish` 不匹配。站点加速的 zone 级边缘函数不能拦截 Makers 托管域名。
- 当时只验证了 HTTP GET/POST、CDN 响应头及 SPA fallback；WS 握手成功后的数据转发失败才是撤销原因。`200 + HTML` 表示反代未生效，是另一种故障。
- Makers 项目使用 GitHub 集成，由远端 main 更新触发构建，CLI 不能直传部署。常规发布使用本机签名提交与 push；REST contents 提交会丢失 SSH 签名，不作为常规替代。

### 探针与完成条件

- 对后端公开基址请求 `/health`、`/livez`、`/readyz`，核对状态码与 JSON 内容，不能只接受 HTTP 200（首页 HTML 也可能是 200）。
- HTTP 代理验证使用已知只读 GET 端点，并检查响应体和 `x-trace-id`。不得用标签提交等 POST 写接口探测连通性。
- WS 验证连接后发送只读大厅订阅等命令并检查关联 ACK；可能创建房间或改变对局的命令使用隔离本地实例。
- 生产目标的检查仅在已有授权范围内运行。只修改文档不触发线上探针；历史“已验证”不能替代本次发布证据。

## 前端静态外壳 (Static Shell)

前端是纯前端 SPA，构建产物的 `<div id="root">` 默认是空的：执行 JS 的爬虫能自行渲染，
不执行 JS 的爬虫（百度为主）只能读到空壳，收录无从谈起。构建末尾由 `vite.config.ts` 的
`static-shell` 插件把 `Client/src/data/PageMeta.ts` 里的正文与 head 元信息写进各路由的 HTML，
爬虫无需执行 JS 即可读到内容。

- **零浏览器依赖**：插件是纯 Node 字符串注入。**不要改回无头浏览器预渲染**——平台构建容器
  不提供 Chromium（实测 `Executable doesn't exist ... chromium_headless_shell`），
  让构建去下载 150MB 浏览器既慢又脆；本站可收录页面的正文本来就是数据，由数据生成 HTML 更可靠。
- **文案单一真相源**：`PageMeta.ts` 同时被页面组件的 `Seo`（运行时写 head）与插件（构建期写 HTML）
  消费，改了描述两处一起变。页面侧调用因此简化为 `<Seo path="/" />`；未登记的路径（房间页、
  单人页）必须显式传 `description`，否则组件当场抛错。
- 新增开放大厅须同步 `PageMeta`、主页游戏介绍与链接、站点地图、资源冒烟和 SEO E2E；运行时
  `description` 与 `og:description` 必须读取同一份解析后的文案。房间页保持 `noindex`，并在
  `robots.txt` 排除对应房间路径，CCB 的增强房与原版房共用 `/ccb/room/` 规则。
- 落点（双形态，不赌主机的静态解析规则）：`dist/index.html`、
  `dist/<route>/index.html`（目录索引型主机）、`dist/<route>.html`（clean URL 型主机）。
  别名与正式路径内容一致，重复内容由 canonical 收敛，别名不进 sitemap。
- **正文外壳必须在首次绘制之前消失**：外壳插在 `#root` 内，紧随其后是一段 parser-blocking
  内联脚本 `document.getElementById("root").replaceChildren()`，随解析同步清空。入口是 defer 的
  module 脚本（懒加载路由 chunk 还要再等一次网络），执行时机在首帧之后——只靠它替换 `#root`，
  用户进站会先看到一段未排版的裸文本（线上实际发生过）。**不要改成 `#root{display:none}` 之类的
  CSS 兜底**：那等于把正文标成隐藏文本，与 hidden text 同类；此处不隐藏任何东西，只是让
  JS 客户端先移除、再交给应用渲染。**也不要用 `<noscript>`**：目标恰恰是不执行 JS 的爬虫，
  noscript 内容在多数引擎眼中信号更弱。不执行 JS 的爬虫读的是原始 HTML，外壳照旧可见——
  两边本来就是同一份正文。
- **静态标签必须在客户端启动时摘掉**：注入的 head 标签带 `data-static-seo="1"`，
  `Client/src/lib/StaticSeo.ts` 的 `stripStaticSeo()` 在入口模块（`Main.tsx`）里把它们整体移除，
  再由 react-helmet-async 按当前路由写入真值。**不要改成「让 Helmet 接管静态标签」**——
  react-helmet-async v3 在 React 19 下不走 DOM 复用路径（复用旧标签的逻辑只在旧路径生效），
  它会直接渲染新标签，静态标签留在原地就变成重复 canonical——搜索引擎判定整组失效，比缺失更糟。
  JSON-LD 例外：用固定 id `bakagame-structured-data`，`Seo` 的 useEffect 按同一 id 覆盖内容，不重复。
- 不注入的页面：房间页与单人页——内容由服务端实时状态驱动，没有可静态化的正文，且已标 `noindex`。
- 自校验：插件在注入点缺失或产物缺少标记时直接让构建失败；`scripts/asset-smoke.mjs` 逐路由断言
  外壳存在（无浏览器，跑在 CI 的 client job）；「有没有产生重复标签」由 E2E 用真实浏览器断言
  （strict 定位器遇到重复标签会直接报错）。
- 生产构建命令：平台的 Makers 项目是 GitHub 集成型，构建在平台侧发生，`npm run build` 即可
  （静态外壳已在 build 内完成）。仓库保留了 `build:seo` 作为指向 build 的兼容别名，等控制台
  改回 `npm run build` 后可以删掉。
- 上线验收：用 `curl`（不带 JS）访问 `/`、`/whoisfaker`、`/songuessr`、`/ccb` 四个路由，正文应含对应文案且 canonical 指向自身。
  若平台把游戏大厅回退成了首页外壳，说明静态文件未被解析，
  先检查静态产物与平台路由解析；不要因此恢复上节已撤销的 API/WS 中间件。静态路径规则与实时反代分别验证。

## 边缘缓存策略 (edgeone.json)

`Client/edgeone.json` 是前端响应头与边缘缓存的**唯一真相源**。它是纯数据文件：写错了没有
类型检查、没有构建报错，只会在线上表现为「发版后老用户拿到旧页面」或「静态资源反复回源」。
`Client/src/lib/EdgeCacheConfig.test.ts` 把下面的约定固化成了断言，改错当场失败。

### 分档原则：有没有内容哈希

**缓存时长的唯一判据是「这个文件名会不会随内容变化」，不是「它是什么类型的文件」。**
Vite 产物带 8 位内容哈希（`.js` / `.css` / 字体），内容一变文件名就变，缓存一年也安全；
而 `public/` 下的图片经 `prepare-public-webp.mjs` 转码后**保留原名**，只有 5 个：
`CCB.webp` `Faker.webp` `favicon.webp` `logo.webp` `SongGuessr.webp`。给后者发
`immutable` 等于把换图能力锁死——文件名不变，浏览器与边缘都不会再回源。

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
接受，故障是静默的（改动时实测踩过——`/api/*` 的 `no-store` 被 `/*` 完全屏蔽）。
测试里用「探测路径必须拿到自己那档策略」锁死了这一点。

### headers 与 caches 必须同档

`Cache-Control` 的 `max-age` 与 `caches[].cacheTtl` 描述同一个保鲜期：前者约束浏览器，
后者约束边缘。只改一处会让两侧对同一资源的判断分裂，排查时极难定位，必须成对修改
（测试逐条比对两者相等）。

### 缓存与路由分别验证

`edgeone.json` 的 `/api/*` 规则只声明不缓存，不创建代理路由。当前请求链路、健康探针和同源切换条件见前文；缓存头正确不能证明业务请求到达后端。

发布时按实际部署基址检查三档资源：

```bash
curl -sI https://game.example.com/assets/index-<hash>.js  # 一年 + immutable
curl -sI https://game.example.com/assets/logo.webp        # 七天，无 immutable
curl -sI https://game.example.com/                       # max-age=0, must-revalidate
curl -s https://backend.example.com/health               # 后端 JSON，不是 HTML
curl -s https://backend.example.com/readyz               # ready 为 true
```

其中 `<hash>` 从本次构建获取。前端 `/api/*` 的 no-store 可单独检查，但不得再要求当前前端兜底响应携带后端 `x-trace-id`。

## 应用职责

应用仍必须校验每个命令的结构、身份、权限、阶段和业务数据。代理层的资源保护不能替代
`Server/src/transport/WhoIsFakerProtocol.ts` 与 `WhoIsFakerService`（及 `SonGuessrService`、`CCBService`）的业务校验；应用校验也不能替代代理层的
来源限流和资源配额。

听歌猜番还需要在服务端配置 `BANGUMI_API_URL` 和可选的 `BANGUMI_IMAGE_URL`。这两个地址
只允许由服务端访问；客户端不得直连 Bangumi，代理也不得把 `lain.bgm.tv` 原始图片地址暴露
给浏览器。发布前应验证镜像支持 `/v0/search/subjects` 与 `/v0/subjects/{id}`，并确认图片
镜像保留原始路径、查询参数和片段。

## 带宽与容量基线

实时状态采用带修订号的增量同步，首次连接、重连、修订缺口和周期校准才发送全量。
生产发布前必须运行 `bun test test/NetworkCapacity.test.ts`；其固定验收目标是单台
6 Mbps 出口承载 150 名 WhoIsFaker 玩家，并在每秒 12 次房间变化与每分钟一次全量校准下
保留 15% 的 TLS/TCP/IP 传输余量。代理的带宽监控应按应用出口持续核对这一预算；超过预算时
优先检查新增快照字段、重复事件和广播频率，不得通过取消最终同步或延长到不可接受的状态延迟来过测。

## 隔离启动与交付回归

- `ProductionSmoke.ts` 与 Playwright 后端共用 `scripts/IsolatedServer.ts`：禁用 Bun `.env` 自动加载、环境白名单、清空遥测/账号、临时词库与 enrichment、自有子进程退出竞赛及仅 preload 注入的随机所有者端点；烟测使用独立端口。Playwright 后端与 preview 都不复用现有服务。
- 仅测试 preload 阻断主动 fetch、WebSocket、Node TCP/TLS/HTTP/DNS/UDP 与 Bun.connect/udpSocket，拒绝派生进程并向 Worker 传播守卫；真实第三方测试另行授权，不通过增加重试或放开出口修复测试。该守卫不是操作系统沙箱，不承诺隔离原生扩展或未纳入守卫的新网络 API；常规夹具不得调用这些出口。
- 离线 `bun --no-env-file test scripts/Delivery.test.ts` 覆盖门禁反例、移动分支与固定 SHA、退出假绿、所有者标记、临时目录回收、合成环境与出口拒绝；不运行正式 Index。真实 E2E 的外部图片/音乐需求应由专用 Provider 夹具接替，不可重新放开网络。`ClientCiFilter.mjs` 在 client CI 使用已安装的 picomatch 跑路径反例；Python 构建夹具在普通 PR CI 独立执行，无下载和数据提交。

## 持续部署流水线

触发条件与实际命令以 [deploy.yml](../.github/workflows/deploy.yml) 和 [ci.yml](../.github/workflows/ci.yml) 为准：

- 自动发布由 main 的 `CI` 工作流完成事件触发；gate 要求整体 CI 成功，且 `Server CI` 作业实际执行并成功。客户端或文档改动使服务端作业跳过时，不自动部署后端。
- `Server/**` 与部署脚本自身必须保留在 CI 的服务端路径过滤范围，保证修改发布脚本也经过门禁。
- 部署消费 CI 结果，不在 deploy 中重复跑一遍完整测试。手动 `workflow_dispatch` 必须提供 `ci_run_id`，与自动路径共用门禁：同仓库 `main` 的 push、整体 CI 完成且成功、实际 `Server CI` 成功；缺失、失败、取消、跳过或 PR run 均不放行。执行仍需发布授权。
- 前端 Makers 的 main 推送可能独立触发构建；“不部署后端”不代表推送没有任何生产影响。

### 发布链路与失败边界

1. SSH 使用 `appleboy/ssh-action`，`script_stop: false`，由脚本 `set -euo pipefail` 管理失败；作业与 SSH 命令均限 3 分钟。
2. 门禁输出获验 run ID 与完整 40 位 SHA；远端 `/BakaGame` fetch/reset 该 SHA，并核验 HEAD 一致，所有 LFS raw URL 同样绑定此 SHA（不消费移动 main），按下节规则校验、复用或下载 LFS 数据库。这是部署环境操作，不在本地开发工作区照抄 `reset --hard`。
3. 数据校验后、排空前生成获验修订的 release 元数据，流程及失败边界见下一节；宿主机不需要 Node/Bun。
4. 排空前通过容器内 `DeploymentNotify.ts` 调用本机 `POST /api/system/notify-shutdown`，从生产容器环境读取 `MAINTENANCE_TOKEN` 并以 Bearer 鉴权，不使用自报 `X-Real-IP`、不打印 token、不放入命令参数。容器必须通过运行环境显式注入该变量（只在 `.env` 内提供不足以供 `--no-env-file` helper 消费）；缺失、非成功状态或 3 秒超时均中止部署且不重启，不声称预通知成功。接口向三款游戏广播并摘除 readiness。
5. 等待 3 秒排空，重启 `BakaGame` 容器；容器入口负责依赖同步与服务拉起。
6. 在总计 30 秒预算内检查本机 `/health`、`/livez`、`/readyz` 的 `ready:true` 与三款游戏订阅 ACK（不创建房间）。通过 `docker exec -i` 将目标 SHA 的只读 `DeploymentProbe.ts` 送入容器 Bun，不猜测挂载路径，不加载应用或 `.env`。失败打印容器末尾日志、作业失败，不报部署成功；重启后不自动二次重启或回滚，由运维依据日志与获验 SHA 恢复。

### 发布元数据与遥测验收

- reset 获验 SHA 并核对 `COMMIT == DEPLOY_REV`、数据库校验完成后，维护通知/重启前生成 `Server/build/release.json`。只允许 schemaVersion、完整 40 位小写 revision 与 changelog 的最新稳定 semver 三个字段，不含环境变量、凭据或私有端点；现有 `.gitignore` 已忽略整个 `Server/build`。
- 元数据逻辑由 `Server/src/infrastructure/Release.ts` 唯一维护：宿主用 `docker exec -i` 把该获验修订的源文件经 stdin 送入**已存在**的容器 Bun，以 `--no-env-file -` 运行；SHA 和该修订的公开 changelog JSON 作为两个参数传入。仅导入标准库，不加载应用/SDK，不要求宿主安装 Node/Bun，不猜测容器中的源码挂载路径。
- 宿主先用 `mktemp` 在目标 build 目录创建临时文件，容器 stdout 写入该文件；退出成功后将其设为可读的 0644 并同目录 `mv` 原子替换。无效/缺失 SHA、损坏 JSON、无稳定版本、脚本异常或 3 秒截止均中止发布、不进入维护通知及容器重启，旧元数据不被截断，临时文件由失败分支/退出陷阱清理。Linux 宿主须通过现有环境自检提供 `cat/chmod/timeout`。
- 运行时以模块位置定位 Server/仓库根，真实根 Git HEAD 与 changelog 优先，拒绝当前工作目录、父仓库及继承 GIT_DIR/GIT_WORK_TREE 导致的错误修订；无根 Git 时校验 metadata。生成后的 build 目录必须随 Server 的现有挂载/部署进入容器；无有效证据返回 `undefined` 并在 Sentry 启用时提示，不以硬编码旧版本或任意环境字符串冒充 release。canonical 格式为 `Vx.y.z（hash）`，完整 SHA 只在元数据保留，展示 hash 统一 7 位。
- 环境解析优先级及 development 缺省见 [Conventions](Conventions.md#运行环境标记与资产验证隔离)，生产必须显式注入 production；Sentry 与 OTLP 使用同一标记。`Server/test/Release.test.ts` 执行真实 stdin 元数据脚本及从 workflow 提取的原子落盘阶段，Docker/sudo 在临时目录模拟，不重启真实容器；配套 Env/Sentry 测试均无真实遥测写入。
- 本地修复不等于线上缺 release 流量已经消失。本轮父审只读样本显示缺 release 日志来自旧 SDK 10.73.0 producer，当前仓库 SDK 为 10.75.1；须另行获授权部署后，按 SDK、实例、environment 与 canonical release 复核新 producer，并区分历史日志。本文与本地测试不声称已替换生产实例或删除旧事件。

### 时间预算铁律

生产服务器位于中国大陆，出境链路质量不可控。`deploy` 作业的每一段都必须落在预算内，
**任何新的部署步骤都要先声明它占用的秒数**，否则不得合入：

| 阶段 | 预算 |
|---|---|
| runner 准备 + SSH 建连 | ≤ 15s |
| `git fetch` + `reset` + 数据库校验 | ≤ 10s |
| 节点测速 | ≤ 7s |
| 数据下载（仅数据变更时才发生） | 受 `DL_DEADLINE` 约束；当前为从脚本开始起 115s 的绝对截止，包含此前耗时 |
| release 元数据生成与原子落盘 | ≤ 3s（容器元数据脚本由 `timeout 3s` 约束） |
| 客户端排空 | ≤ 3s |
| 运维 Bearer 通知 | ≤ 3s |
| 容器重启 | ≤ 5s |
| 健康检查 | ≤ 30s |

下载截止时间与其他阶段预算有重叠，不能把表内数字直接相加。整体仍须满足 3 分钟硬超时。**常态部署（数据未变）应在 60s 内完成**，
这是目标值而非上限：数据下载路径必须设计成"无事发生"。

### Git LFS 大文件获取约束

`Server/data/bangumi-*.sqlite` 由 Git LFS 托管，是流水线中的大文件；实际大小以 LFS 指针为准，不把历史约 200MB 的样本量写成固定预算。
在大陆服务器上，**任何"顺手 `git lfs pull`"的写法都是不可接受的**，原因与对策如下：

#### SSH 执行与文件替换

- **严禁 `script_stop: true`**。drone-ssh 开启它之后会对脚本**逐行改写**，在每条命令后
  注入 `DRONE_SSH_PREV_COMMAND_EXIT_CODE=$?; [ $... -ne 0 ] && exit ...`。后果是：
  任何**合法地为假**的 `if` 条件或 `&&` 链（状态码 1）都会被当成失败直接 `exit 1`，
  多行命令（`if/while/函数体`）也会被截断。表现为"脚本在某个完全正常的分支处静默退出、
  看似陷阱没触发"——其实 EXIT 陷阱触发了，只是 `on_exit` 里又被注入的检查再次打断。
  失败即停由脚本自己的 `set -euo pipefail` 负责，`script_stop` 必须保持 `false`。
- **往暂存区写实体文件前必须先验魔数**。`mv -f "$f" "$STASH/..."` 若在工作区是指针文本
  （上一次失败运行留下的）时执行，会把暂存区里唯一的真实数据库覆盖成 133 字节指针，
  **生产数据就此丢失**，只能靠重新下载恢复。正确做法：工作区内容通过
  `head -c 15` 验过是 `SQLite format 3`、且暂存区没有有效副本时才搬，否则直接丢弃工作区那份。

- **LFS 镜像前缀对实体下载无效**。把 `remote.origin.lfsurl` 改成
  `https://<代理>/https://github.com/<repo>.git/info/lfs` 只能让体积微小的 batch
  小请求走代理；batch 响应里的 `href` 由 GitHub 返回，指向
  `github-cloud.githubusercontent.com/alambic/media/...` 这类签名直链，git-lfs 会
  **直连**它。也就是说代理只加速了几百字节的元数据，200MB 实体依旧是裸奔出境。
  排查时必须同时看"镜像是否生效"与"实体字节从哪个域名下来"，只看前者会误判。
- **实体下载必须走 `raw` 形态的通用代理**：
  `https://<节点>/https://github.com/<repo>/raw/<ref>/<path>`。该形态下代理在服务端
  跟随 GitHub 到 `media.githubusercontent.com` 的 302，返回的是真实字节而非 LFS
  指针文本。**不要用 `media.githubusercontent.com` 直接拼前缀**：多数代理白名单里
  没有这个域名，会直接 403。节点清单维护在
  [https://github.akams.cn/](https://github.akams.cn/)，脚本内置多个节点并在每次部署
  时并行测速选最快者，单点失效不影响整体。
- **测速探针必须校验内容而不是只看速度**。403/404 错误页体积小、`speed_download`
  虚高，极易被误选成"最快节点"。只有响应体前 15 字节等于 `SQLite format 3` 的节点
  才计入有效测速结果。
- **禁止 smudge，实体文件由脚本接管**。部署脚本先 `export GIT_LFS_SKIP_SMUDGE=1`，
  再把已就位的库文件挪到 `<仓库>/.deploy-stash`，`git reset --hard` 后按 LFS OID
  比对：OID 未变则原子 `mv` 回位，**零网络**；OID 变化才下载。这是达成 1 分钟部署的
  核心机制——数据一周才更新一次，九成以上的部署不该产生任何大文件流量。
- **校验以 sha256 对齐 LFS OID 为唯一标准**。文件大小、SQLite 魔数、`sha256sum ==
  oid` 三者都通过才算成功，缺一不可。
- **LFS 指针一律用纯 shell 解析，禁止 `git show` + `awk`**。曾经的写法
  `want=$(git show "HEAD:$f" | awk '/^oid sha256:/{print $2; exit}')` 有两个致命问题：
  `awk` 的 `$2` 会带出 `sha256:` 前缀（而 `sha256sum` 输出的是裸十六进制，比对永远不命中，
  缓存复用形同虚设）；且该管道是 `set -e` 下唯一不受 `if` 保护的语句，一旦 `git show`
  在生产机上失败就直接静默退出 —— 表现为「日志停在最后一行 `say` 之后，连 EXIT 陷阱
  都没触发」。正确做法：`git reset --hard` 后工作区里就是指针文本，用
  `while read -r k v` 直接读文件即可，零外部命令、零管道、不可能因工具缺失或
  SIGPIPE 崩掉。
- **任何失败必须带行号喊出来**。脚本必须 `set -E` 加
  `trap 'echo "❌ 第 ${LINENO} 行失败：$BASH_COMMAND"' ERR`，并且每个阶段都要打印
  检查点（目标 OID/大小、复用还是下载、各节点测速结果）。静默失败会让排查成本翻十倍
  —— 一次部署只有 3 分钟，没有第二次机会慢慢猜。
- **开工先做环境自检**：`git/curl/awk/sort/tr/wc/head/basename/sha256sum/date/grep`
  逐个 `command -v`，缺哪个就报名字退出。生产机环境不受本仓库控制，不要假设它齐全。
- **重启前的准备失败必须恢复旧数据且不重启容器**。脚本用 `trap ... EXIT` 在非零退出时把旧库文件放回
  原位，避免把指针文本留在工作区、让下一次容器重启直接读到坏数据；同时失败路径
  不执行 `docker restart`，线上服务保持原状。
- **断点续传**：分片目录按 `文件名 + 目标 OID 前缀` 命名并跨运行保留（`on_exit` 只清理
  `.probe` 与 `.merged.*`，不动 `.parts.*`），长度已满的分片直接复用，整体 sha256 兜底。
  数据库被毁后首次恢复要拉 200MB，一次跑不完就下次接着跑，而不是每次从零开始。
- **镜像对同 IP 的并发突发会 403**（Cloudflare 前置）。探针要错峰发起（`sleep 0.25`），
  分片下载带 `--retry 2 --retry-delay 1`。排查下载失败时先看是不是 403/429，而不是盲调超时。
- **并发临时路径不能用 `$$` 命名**。两个库文件是并行下载的，而 bash 的 `$$` 在子
  shell 中仍是父进程 PID，用它拼临时目录会让两个任务互相覆盖，最终产出体积正确但
  内容错乱的文件。临时路径必须由文件名派生。

### GitHub Secrets 密钥配置规范

严禁将真实服务器凭据提交至代码库。部署依赖以下 GitHub Repository Secrets：

| Secret 名称 | 说明 | 示例/默认值 |
|---|---|---|
| `DEPLOY_HOST` | 生产服务器 IP 地址或域名 | 必填 |
| `DEPLOY_PORT` | SSH 端口号 | 未设置时默认 `22` |
| `DEPLOY_USER` | SSH 登录用户名 | `ubuntu`（未设置时默认 `ubuntu`） |
| `DEPLOY_KEY` | 用于 SSH 鉴权的私钥纯文本 | 必填（完整包含 BEGIN/END 标记） |
| `DEPLOY_PASSPHRASE` | 用于解密 SSH 私钥的密码（若私钥受密码保护） | 可选（私钥无密码保护时无需配置） |
