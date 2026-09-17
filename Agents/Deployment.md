# 生产部署边界

WhoIsFaker、Songuessr 与 CCB 的实时业务分别通过 `/api/whoisfaker/ws`、
`/api/songuessr/ws` 和 `/api/ccb/ws` 提供。应用服务负责 WebSocket
协议解析、业务权限和房间状态，不在进程内按来源 IP 实现限流或连接配额。

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

## 前后端同源化 (Same-Origin API Gateway)

前端（Makers 托管）与后端（自有服务器）分属不同域名时，所有请求都是跨域请求。
`Client/middleware.js` 在 EdgeOne Makers 边缘把同源 `/api/*` 反代到后端公开域名，
使浏览器侧全部变为同源请求：不再有 CORS 预检、不再依赖服务端 Origin 白名单放行
浏览器跨域、WebSocket 升级也不再暴露给第三方域名的伪造 Origin 探测。

### 请求链路与 CDN 关系

`浏览器 → game.baka.website（Makers 边缘，rewrite）→ gameserver.baka.website（EdgeOne
站点加速层）→ 自有服务器`。rewrite 的目标是后端的**公开域名**而非源站 IP，后端域名
自身仍套在站点加速层后面，加速能力完整保留——只是发起方从浏览器变成边缘节点。

### 实测结论（2026-09 验证，勿凭直觉推翻）

- Makers middleware 的 `rewrite()` **支持跨域绝对地址**，底层由边缘运行时注入的
  `fetch` 执行；官方文档示例只演示站内路径，跨域能力是实测得出的。
- 本地 `edgeone makers dev` **无法验证跨域 rewrite**：本地运行时没有注入该 `fetch`
  （报 `Cannot read properties of undefined (reading 'fetch')`，恒 502）。跨域反代
  只能部署到真实边缘后探测。
- middleware `matcher: ["/api/:path*"]` 优先于 SPA fallback，`/apiish` 等相似前缀
  不受影响。
- **站点加速（zone 级）的边缘函数拦不到 Makers 托管域名**（控制台探针实测）：
  反代只能做在 Makers 项目内部（middleware.js 或 edge-functions 文件），
  不要再尝试 zone 级配置。
- `Client/middleware.js` 已在 ccb 站点（anime-character-guessr 前端）生产验证：
  GET/POST 全通、`eo-cache-status` 等 CDN 头保留、SPA fallback 无干扰。
- **WebSocket 升级可穿透边缘 rewrite**：对 `wss://game.baka.website/api/whoisfaker/ws`
  手工构造 Upgrade 请求（Origin 为前端域名）实测返回 `101 Switching Protocols`，
  `Sec-WebSocket-Accept` 为 RFC 6455 标准应答，握手由后端真实完成。同源化后浏览器
  发送的 Origin 不变（仍是页面 origin），服务端 `CLIENT_URL` 校验无需改动。
- BakaGame 前端的 Makers 项目是 **GitHub 集成型**（Provider 'Github'），CLI 不能
  直传部署，只能推送远端 main 触发自动构建。沙箱内可用 `gh api` contents API 追加
  文件触发部署，但 REST 提交丢失 SSH 签名——签名仓库的常规变更仍应本机 push，
  REST 提交仅用于紧急解锁；本地同内容签名提交在 `git pull --rebase` 时按补丁
  自动去重。

### 客户端基址约定

`Client/src/lib/ServerEndpoint.ts` 是接口基址的唯一真相源：生产构建
`VITE_SERVER_URL` 留空（或显式 `/`、`same-origin`）时走同源相对路径，由边缘中间件
反代；本地开发经 `.env` 指向 `http://localhost:4850`。WebSocket 相对地址由
`WebsocketClient` 按 `location` 显式补全协议与主机。

### 边缘探针与验证方法

- 验证反代是否生效：`GET https://game.baka.website/api/game/status`，响应带
  `x-trace-id` 头且响应体为 Elysia JSON（即使 404）即代表穿透到了后端；
  Makers 自身的 404 不带该头。
- 健康探针：gameserver 的 `/health` 在根路径（不在 `/api/*` 下，不会被反代），
  跨域验证一律走 `/api/*` 下真实存在的端点。
- 探测禁止使用带副作用的接口（曾对 ccb 的 `POST /api/character-tags` 发出真实
  写入），验证只用 GET 探针。

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
- 上线验收：用 `curl`（不带 JS）访问三个路由，正文应含对应文案且 canonical 指向自身。
  若平台把 `/whoisfaker`、`/songuessr` 回退成了首页外壳，说明静态文件未被解析，
  需在 `Client/middleware.js` 里补路径 rewrite——这是本方案唯一依赖平台行为的一环。

## 应用职责

应用仍必须校验每个命令的结构、身份、权限、阶段和业务数据。代理层的资源保护不能替代
`Server/src/transport/WhoIsFakerProtocol.ts` 与 `WhoIsFakerService`（及 `SonGuessrService`）的业务校验；应用校验也不能替代代理层的
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

## 持续部署流水线 (Continuous Deployment)

后端采用 GitHub Actions 自动化部署流水线（`.github/workflows/deploy.yml`），在代码推送至 `main` 分支且包含 `Server/**` 或 `.github/workflows/deploy.yml` 变更时，或通过 `workflow_dispatch` 手动触发时自动更新服务器。仅客户端或非服务端文件（如 `Client/`、`Agents/`、文档等）变更时不会触发后端部署。

**部署脚本自身必须列入触发路径**：只写 `Server/**` 会导致改完流水线还得手工 dispatch 才生效，
改动的正确性无法在真实部署里被验证，故障会被推迟到下一次有人改服务端代码时才暴露。

### 流水线架构与流程

1. **前置质量门禁 (`verify`)**：
   - 在 GitHub Actions 托管 runner (`ubuntu-latest`) 中安装 Bun 环境并执行 `bun install`。
   - 运行严格 TypeScript 类型检查 (`bun run check`) 与全量测试套件 (`bun test`)。
   - 任何类型错误或单测失败立即阻断流水线，绝不向生产环境推送未验证的代码。
2. **远程安全连接 (`deploy`)**：
   - 通过 `appleboy/ssh-action` 建立至生产服务器的 SSH 会话，严格保持 `script_stop: false`（由脚本自身的 `set -euo pipefail` 保证失败即停，防止注入检查截断多行逻辑）。
   - `command_timeout: 3m`，且 `deploy` 作业设 `timeout-minutes: 3` 作为硬兜底：生产部署不允许长时间挂起。
3. **代码对齐与数据库校验**：
   - 切换至 `/BakaGame` 仓库目录。
   - 执行 `git fetch origin main && git reset --hard origin/main` 对齐生产分支，并按 OID 校验或增量下载 LFS SQLite 数据库。
4. **停机预告与客户端排空 (`Pre-restart Drain`)**：
   - 调用 `POST http://127.0.0.1:4850/api/system/notify-shutdown` 运维端点（该接口**严格且 fail-closed** 地校验 `X-Forwarded-For` 与 `X-Real-IP`：取不到来源 IP 或任一跳为公网 IP 一律 403，仅允许本地回环与私网调用）。
   - ⚠️ **调用方必须显式带上来源头**（流水线里写的是 `-H "X-Real-IP: 127.0.0.1"`）。本机直连 4850 端口时不经过任何反向代理，两个转发头都不存在；在旧的 fail-open 实现下这会整块跳过校验，而改 fail-closed 之后会被直接拒绝 —— 忘记带头的部署脚本会拿不到 200，只能拿到 403。
   - 服务端向 WhoIsFaker 与 SonGuessr 双模式所有在线玩家广播停机公告（`SERVER_SHUTDOWN_MESSAGE`），并立即使 `/readyz` 探针返回 503 摘除流量。
   - 部署脚本预留 3 秒排空缓冲（`sleep 3`），确保客户端长连接在容器网络被 Docker 拆除前安全接收协议、清除会话凭据并平滑退回大厅。
5. **容器热重启**：
   - 执行 `sudo docker restart BakaGame` 热重启后端容器。容器启动入口自带依赖安装与环境初始化逻辑，每次启动时自动完成容器内部服务端依赖的同步与服务拉起。
6. **就绪探测与健康检查**：
   - 轮询 `http://127.0.0.1:4850/health` 端点（最多重试 15 次，每次间隔 2 秒）。
   - 验证响应中包含 `{"status":"ok"}`。
   - 若 30 秒内未能就绪，自动打印 `sudo docker logs --tail 50 BakaGame` 并退出报错，便于在 Actions 界面快速定位崩溃日志。

### 时间预算铁律

生产服务器位于中国大陆，出境链路质量不可控。`deploy` 作业的每一段都必须落在预算内，
**任何新的部署步骤都要先声明它占用的秒数**，否则不得合入：

| 阶段 | 预算 |
|---|---|
| runner 准备 + SSH 建连 | ≤ 15s |
| `git fetch` + `reset` + 数据库校验 | ≤ 10s |
| 节点测速 | ≤ 7s |
| 数据下载（仅数据变更时才发生） | ≤ 105s（脚本内 `DL_DEADLINE` 绝对截止） |
| 停机通知与客户端排空 | ≤ 3s |
| 容器重启 | ≤ 5s |
| 健康检查 | ≤ 30s |

合计上限约 175s，仍留 5s 余量给 3 分钟硬超时。**常态部署（数据未变）应在 60s 内完成**，
这是目标值而非上限：数据下载路径必须设计成"无事发生"。

### Git LFS 大文件获取约束（中国大陆服务器）

`Server/data/bangumi-*.sqlite` 由 Git LFS 托管（合计约 200MB），是本流水线唯一的重资产。
在大陆服务器上，**任何"顺手 `git lfs pull`"的写法都是不可接受的**，原因与对策如下：

### ssh-action 两个必须记住的坑（三轮部署失败的真凶）

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
- **失败必须回滚且不重启容器**。脚本用 `trap ... EXIT` 在非零退出时把旧库文件放回
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
| `DEPLOY_PORT` | SSH 端口号（非标端口） | `5438`（未设置时默认 `22`） |
| `DEPLOY_USER` | SSH 登录用户名 | `ubuntu`（未设置时默认 `ubuntu`） |
| `DEPLOY_KEY` | 用于 SSH 鉴权的私钥纯文本 | 必填（完整包含 BEGIN/END 标记） |
| `DEPLOY_PASSPHRASE` | 用于解密 SSH 私钥的密码（若私钥受密码保护） | 可选（私钥无密码保护时无需配置） |
