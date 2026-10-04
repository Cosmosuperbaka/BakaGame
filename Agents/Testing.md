# 测试体系

选择验证范围、编写测试或修改 CI 时查阅本文。先用下表确定需要的检查，再阅读对应层级；排障章节只在出现相关症状时使用。命令分别在 `Server/`（Bun）和 `Client/`（Node/npm）内执行。

## 验证范围

| 改动类型 | 完成所需的验证 |
|---|---|
| 纯文档或注释 | 检查 diff、链接、引用路径、命令与规则一致性；不运行无关业务套件 |
| 局部服务端行为 | 相关 `bun test` 文件 + `bun run check`；新增行为或缺陷补有判别力的回归 |
| 局部客户端逻辑 | 相关 Vitest 文件 + `npm run lint` + `npm run build` |
| 页面样式或动效 | lint、build 与受影响页面浏览器验证；按 Design / Animation 检查相关状态及视口，不为样式类新增镜像单测；受影响组件的故事同步更新，用 `storybook:shots --filter` 做改前改后截图对照 |
| Storybook 故事、假数据或截图工具 | `npx tsc -p tsconfig.app.json --noEmit`、lint、`npm run build-storybook`，相关故事 `storybook:shots` 零失败、零控制台错误 |
| 共享协议、跨游戏基础设施、全局状态同步 | 两端类型/构建与相关协议、Store、服务回归；涉及握手或路由时验证真实命令 ACK |
| 快照、私有状态、封包或广播频率 | `Server/test/NetworkCapacity.test.ts`，保留全部容量与最终同步断言 |
| 歌词几何、字体或动画 | `npm run test:lyrics`；jsdom 高度模拟不替代真实浏览器 |
| 资源、构建插件或静态外壳 | `npm run test:asset-smoke` 与相关 SEO / 资源 E2E |
| 依赖或运行时升级 | 升级前后以同一组检查验证受影响包；Server check + test，Client lint + coverage + build；浏览器/构建依赖另跑相关 E2E，基础运行时或跨端影响覆盖两端 |
| CI、发布准备或明确要求完整回归 | 对应包 `verify`，发布另查 Deployment；服务启动/运维端点改动补 `test:production-smoke` |

本地单测和隔离冒烟可直接运行、修复本次引入的失败并重跑。通过后不重复扩大检查；新改动、失败或未消除风险才增加验证。全量 CI 门禁继续执行，不要求每个局部编辑都先跑完整 CI。

普通测试使用隔离夹具与 Mock 上游；真实网易云测试单独调用，会使用本地凭据。按已有授权和 [NeteaseMusicApi](NeteaseMusicApi.md#测试要求) 执行，不把它当普通单测。环境缺失时记录未验证范围，不用改低阈值或伪造通过来交付。

## 当前门禁与事实来源

当前已落地的门禁：

- 测试夹具在清理临时目录前会排空词库异步写队列；结算流程和资源路径均有回归覆盖。
- 客户端生产构建后执行资源冒烟，检查入口 HTML、固定 WebP、哈希贴纸、SPA 路由和 MIME。
- 服务端与客户端覆盖率命令已进入 CI。阈值只在 [CheckCoverage.ts](../Server/scripts/CheckCoverage.ts) 与 [vitest.config.ts](../Client/vitest.config.ts) 维护，本文不复制易过期的数值。CI 会保留两端 lcov/HTML 报告。
- `Server/scripts/ProductionSmoke.ts` 启动真实服务进程，检查 `/health`、`/livez`、`/readyz` 以及 WhoIsFaker、SonGuessr、CCB 三个 WebSocket 入口的大厅订阅 ACK；使用隔离端口和无网络上游，不访问真实第三方。
- 聊天气泡使用 `data-testid="chat-message-bubble"`，E2E 不再读取 Tailwind 类名；关键落地页和聊天流程会将页面异常、控制台错误及非预期 4xx 转为测试失败。
- 客户端 CI 在生产构建后执行 `npm run build-storybook`，防止故事与截图工具随组件改动失效。

以下事项属于后续容量或维护工作，目前没有伪装成已完成的门禁：拆分过大的 E2E 文件、长连接稳定性与断线矩阵、夜间真实第三方集成、持续容量趋势报告，以及按模块设置更细粒度的覆盖率阈值。新增测试应先补齐对应行为和夹具，再考虑把它们纳入 CI。

## 测试分层

| 层级 | 位置 | 运行器 | 主要职责 |
|---|---|---|---|
| 后端单元测试 | `Server/test/Rules.test.ts`、`ConnectionRegistry.test.ts`、`WordBankRepository.test.ts`、`Server/test/LocalBangumiProvider.test.ts`、`Server/test/FallbackBangumiProvider.test.ts`、`Server/test/BangumiProvider.test.ts`、`Server/test/BangumiWorkerProvider.test.ts` | `bun:test` | 纯规则、连接筛选、错误码、广播隔离、词库去重与并发持久化、Bangumi 本地数据与远端回退、远端请求截止/排队与 Worker 缓存/图片重写 |
| 后端服务回归 | `Server/test/WhoIsFakerService.test.ts`、`TestRoom.test.ts`、`SonGuessrService.test.ts`、`Server/test/CCBNativeLifecycle.test.ts`、`Server/test/CCBNativeModes.test.ts`、`Server/test/CCBNativeBoundaries.test.ts`、`Server/test/CCBOriginalService.test.ts`、`Server/test/CCBOriginalRounds.test.ts` | `bun:test` | 状态机、会话重连、房主宽限、角色限制、测试房间、SonGuessr 歌曲与番剧流程、CCB 原生房间生命周期、模式与边界、原版互通服务与回合 |
| 协议与传输集成 | `Server/test/WhoIsFakerProtocol.test.ts`、`App.test.ts`、`CommandHandlers.test.ts`、`SonGuessrProtocol.test.ts`、`NeteaseMusicProvider.test.ts`、`Server/test/CCBProtocol.test.ts`、`Server/test/CCBTransport.test.ts`、`Server/test/CCBOriginalProtocol.test.ts` | `bun:test` | 消息解析、OpenAPI、HTTP、CORS、真实 WebSocket、命令分发、SonGuessr 协议、网易云接口 Mock 与解析、CCB 协议与 WebSocket 传输及原版协议 |
| 网络承载回归 | `Server/test/NetworkCapacity.test.ts`、`StateSync.test.ts` | `bun:test` | 150 人 / 6 Mbps 容量预算、差量与全量同步 |
| 前端单元测试 | `Client/src/lib/*.test.ts`、`Client/src/hooks/*.test.tsx` | Vitest + jsdom | 会话存储、日志解析、发言列、WebSocket 客户端、自定义 Hook |
| 前端集成回归 | `Client/src/stores/*.test.ts`、`Client/src/App.test.tsx` | Vitest + Testing Library | Zustand 与 WS 联动、标签页替换、路由回退 |
| 端到端测试 | `Client/e2e/*.spec.ts` | Playwright | 落地页、大厅、移动端、双浏览器真实房间流程 |
| 组件截图 | `Client/src/**/*.stories.tsx` | Storybook + Playwright | 全部组件与阶段状态的亮/暗、三档视口范例，供样式审查与改前改后对照；不做像素断言 |

## 常用命令

服务端：

```bash
cd Server
bun test
bun run test:coverage
bun run test:production-smoke
bun run verify
bun test test/NetworkCapacity.test.ts
# Bangumi：本地数据、降级、远端请求边界、Worker 图片/缓存
bun test test/LocalBangumiProvider.test.ts test/FallbackBangumiProvider.test.ts test/BangumiProvider.test.ts test/BangumiWorkerProvider.test.ts
# CCB：按原生服务、协议传输、原版互通链路选择，不再使用已拆除的总套件名
bun test test/CCBNativeLifecycle.test.ts test/CCBNativeModes.test.ts test/CCBNativeBoundaries.test.ts test/CCBRules.test.ts
bun test test/CCBProtocol.test.ts test/CCBTransport.test.ts
bun test test/CCBOriginalService.test.ts test/CCBOriginalRounds.test.ts test/CCBOriginalProtocol.test.ts

# 需要本地 Server/.env 中存在 NETEASE_COOKIE；不会在常规 bun test 中执行
bun run test:music:real
```

客户端：

```bash
cd Client
npm test
npm run test:watch
npm run test:coverage
npm run test:e2e
npm run test:lyrics   # 原生歌词布局、字体、翻译注音、和声及连续动画浏览器回归
npm run verify
npm run storybook                           # 组件工作台，http://localhost:6006
npm run storybook:shots                     # 全量截图，输出 storybook-shots/index.html
npm run storybook:shots -- --filter 猜歌 --out storybook-shots/after
npm run build-storybook                     # 静态构建，CI 冒烟
```

只运行单个用例文件：

```bash
cd Server
bun test test/WhoIsFakerService.test.ts

cd Client
npx vitest run src/lib/WebsocketClient.test.ts
npx playwright test e2e/App.spec.ts
```

## 依赖与浏览器

- 服务端只使用 `Server/bun.lock`，安装时运行 `bun install --frozen-lockfile`。
- 客户端只使用 `Client/package-lock.json`，安装时运行 `npm ci`。
- Windows 本地 Playwright 默认复用系统 Microsoft Edge 的 Chromium 内核。
- 其他平台或 CI 先运行 `npx playwright install --with-deps chromium`。
- 常规 Playwright 自动启动服务端与生产 `vite preview`：后端探活 `http://127.0.0.1:4850/health`，前端探活 `http://127.0.0.1:5173`，页面基址 `http://127.0.0.1:5173`。单独运行 Playwright 前先构建；`test:e2e` 已包含 build。歌词套件另用 Vite 5177。

### 客户端 E2E 隔离边界

- 常规浏览器回归先用 `node scripts/e2e-build.mjs` 构建，再执行 `playwright test`。入口跨平台调用已安装的 TypeScript/Vite，不经 shell 拼接；Vite `envDir: false` 禁止加载 `.env`，显式设置 `VITE_SENTRY_DSN` 为空、`VITE_SERVER_URL=http://127.0.0.1:4850`。`NODE_ENV` 与 mode 仍为 production，不绕过仅生产生效的行为。
- App/CCB/SEO/歌词 统一导入 `e2e/fixtures/Isolation.ts`；默认 context 自动装守卫，额外参与者使用 `isolatedContext` fixture，不裸调 `browser.newContext`。创建页面前安装 HTTP/WS route，仅允许 localhost、IPv4 loopback 与 `::1`，外部连接 abort/close 且在 teardown 明确失败；默认和额外 context 均禁用 Service Worker。允许的 HTTP 请求由 `route.fetch({ maxRedirects: 0 })` 取回再 fulfill；带 Location 的 HTTP 重定向明确失败，不让浏览器在只拦首跳的路由机制下隐式外跳。
- Edge/Chromium 的 Local Network Access 权限只授予当前套件回环 `baseURL` 的 origin（应用 5173、歌词 5177），用于本地 WS 路由桥；所有默认及手动 context 均使用同一范围，不禁用浏览器安全，也不授权外部来源。
- 页级合成夹具不得通过 `route.continue()` 绕过 context 守卫，未命中用 `fallback()`。CCB 可选图片只能本地合成 fulfill，WS 图片夹具只匹配 loopback，不能接通真实上游。原有页面异常、控制台及非预期 HTTP 错误质量断言保留。网易云登录二维码在浏览器边界仅替换创建/轮询 ACK，使用不可扫描的合成图片；房间命令透传真实隔离服务，保留可见、图片加载和恰好一次创建断言，不以开放真实出口让登录测试通过。
- 隔离 context 通过 `closeIsolatedContext` 收尾：保持页级拒绝出口，再用框架 `unrouteAll({ behavior: "wait" })` 排空在途 HTTP handler，最后关闭目标。不使用 `ignoreErrors` 吞掉异常，不在 fulfill 后再次 abort。资源屏蔽/合成路由只匹配 loopback，未命中 fallback 至共享守卫（明确合成的可选外部角色图片除外）。
- 歌词套件的 Vite 就绪探针请求真实生产 CSS `src/index.css`，不是只检查能先返回的夹具 HTML。冷编译完成后才启动首例，保留每例 30 秒超时及页面/控制台错误断言；不要靠扩大测试超时或跳过加载检查掩盖资源尚未就绪。
- `APIRequestContext` 不受浏览器 route 拦截。SEO 原始 HTML 请求通过 `getLoopback` 校验目标并禁用自动重定向；新增 API 请求沿用这一显式边界，不允许直接请求外部 URL。
- E2E 静态预览用 `node scripts/e2e-preview.mjs`：Vite `configFile: false`/`envDir: false`，禁用 proxy 与源文件生成插件，只服务 production dist；页面与就绪探测均显式使用 `127.0.0.1:5173`，不碰用户已有的 `localhost`/`::1` 服务。普通 dev/preview 配置保持不变。
- `playwright test` 本身不会重建已有 dist；手工运行前也必须走上述隔离构建。服务端仍用 `bun --no-env-file run scripts/IsolatedServer.ts`，不复用真实服务。歌词独立套件按其既有专项入口执行，不以本段覆盖其隔离规则。

## 测试编写与维护

- 新行为和缺陷修复覆盖用户可观察结果，缺陷用例应能在修复前失败；纯文案、格式与无行为变化的低风险修改不为覆盖率添加无意义测试。
- 状态机从公开服务入口（如 `WhoIsFakerService.execute`）测试，非 IO 纯业务逻辑真实运行。Zustand 用 `store.setState` 预置并重置状态，不整体 Mock 核心 Store，也不在 Mock 中重写系统。
- UI 断言绑定 ARIA 角色、标签、可见文本与数据契约；`data-testid` 只用于稳定业务元素。布局断言检查 Landmark、导航、真实几何和溢出，不绑定 Tailwind 类名、整串 class 或 DOM 深度。
- 长连接与 Store 测试用 `emitStatus`、`emitMessage` 等语义门面分发事件，不裸调监听器数组下标。
- 时间、退避、抖动、随机与网络驱动通过 `now`、`random`、`fetcher` 参数注入，使用虚拟时钟及受控 Promise；第三方 Provider 测试不做真实 sleep，不用全局 fetch / 随机替换污染并发用例。
- 失败断言核对业务错误码、HTTP 状态或关键错误描述；不使用裸 `toThrow()`、裸 truthy 或只检查调用次数的假测试。安全防护变更另遵循 [Spec §16](Spec.md)。
- 每例独立房间、连接、目录和数据，不依赖顺序；清理前排空持久化写队列。多浏览器上下文、Worker、端口、WebSocket 和子进程在 `finally` / `afterEach` 释放，超时终止子进程。
- Vitest 位于 `Client/src`，Playwright 位于 `Client/e2e`。名称描述行为；不提交 `.only`、无理由 `.skip`、重命名后的镜像测试或已经删除模块的 Mock。
- 核心逻辑覆盖主要分支，覆盖率用于查缺及阻止回退，不堆低价值断言。阈值修改说明基线、空白和风险；Bun 升级重新校准插桩口径，见 [Conventions](Conventions.md)。
- LCOV 的 `FNF/FNH/LF/LH` 按单值解析，不能套用 `DA` 双值格式；无有效计数的报告必须失败。
- 新增生产资源在构建后通过 preview 验证 HTTP 200、MIME、非空内容及可解码性，覆盖入口 HTML、固定 WebP、哈希贴纸与 SPA 路由。只测插件函数或 Vite 开发模式不够。
- E2E 关注跨页面、跨进程和真实用户风险；未处理 rejection、`pageerror`、console error 或非预期 4xx/5xx 令用例失败，能关联当前流程。预期错误用明确白名单并说明原因。
- 生产服务冒烟保持隔离、可重复且不访问第三方；真实第三方集成单独运行、输出脱敏，不进入常规 CI。真实角色 E2E 检出时需拉取 LFS 数据实体。

## 领域专项验收

- CCB 网络容量使用真实原生服务与生产 `StateSyncEncoder`，以 150 名玩家、每秒 12 次猜测、持续
  60 秒以及公共/私有两通道的全量校准计量，连同请求、ACK、WebSocket 帧及 15% 余量不超过
  6 Mbps。必须断言实际产生补丁，不能只检查事件登记或跳过未变化的校准流量。
- CCB 图片提示用生成的栅格图片经过真实 sharp 解码、缩放、模糊及 WebP 编码，校验像素尺寸和
  模糊后方差下降；下载失败、无效地址、损坏图片统一返回业务错误，流式超限及时取消，失败不得
  留在成功缓存或阻塞后续同键请求。图片测试不访问真实上游。
- 歌词几何与动效测试使用 `e2e/SongLyrics.config.ts` 和隔离配置 `Client/e2e/SongLyrics.vite.ts` 单独启动 Vite（5177；独立依赖缓存，不运行应用资源预处理、不写 `.generated-public/` 或 `dist/`），真实挂载 AMLL 与生产 CSS，只替代媒体解码与房间传输。测试入口仅在 `e2e/fixtures/`，不进入生产构建。必须检查首末行边界、字号和宽度变化、首次可见帧、完成与重播的中间帧；不得以手工估算高度的 jsdom 断言代替浏览器验证。

## 组件截图（Storybook）

用于样式审查与改前改后对照，不做像素断言，也不替代 E2E 与单测。

- 故事与组件同目录（`Foo.stories.tsx`），标题按 `基础控件`、`公共组件`、`页面`、`谁是卧底`、`猜歌`、`CCB` 分组，故事名写中文状态。假数据放 `src/stories/fixtures/`，按共享类型构造且与真实业务口径一致；文案同样遵守 [Design §1](Design.md)。
- 连 Store 的组件在 `beforeEach` 用 `src/stories/StorePresets.ts` 预置状态；预览层在每个故事前把全部 Store 复位。故事不得渲染 `layouts/`、`contexts/` 或调用 `init*Ws`，不访问外网：图片用本地资源或数据 URL，截止时间在运行时用 `fromNow` 计算。
- 截图规则由 tags 决定：`page` 整页 × 手机 390 / 平板 900 / 桌面 1440；`overlay` 含 Portal 的整页 × 手机 / 桌面；`mobile` 只拍手机宽度；`no-shot` 不拍；其余按故事根元素取景。每种都出亮、暗两套；暗色只用于样式检查，站内不开放。
- `storybook:shots` 自启独立端口的 Storybook（`--url` 可复用已运行的实例），关闭 framer-motion 过渡并模拟减弱动效，等字体、图片与动画落定后截图。故事渲染失败、页面异常或控制台错误令命令以非零退出。`--filter` 只重拍匹配的故事，索引保留其余故事的上次结果；`--out` 另存一份用于对照。
- 截图基本可复现：「当前时间」固定为脚本里的 `FIXED_NOW`（计时器照常运行，倒计时与相对时间每次都一样），动图（GIF、APNG、动态 WebP）换成首帧静态图，浏览器以同步解码、绘制前完成光栅的软件渲染启动。同一代码两次截图之间只剩少数图片边缘像素、通道差不超过个位数的抗锯齿抖动，因此改前改后对照要按容差比较或目视，不能只比文件哈希。新增故事若两次截图差异明显，先排查其中的随机数、真实时间或外部资源。
- `npm run storybook`、`build-storybook` 与应用的 dev/build 一样会重建 `.generated-public/`，不要与其它 Vite 进程并行启动。

## CI 推荐顺序

```bash
cd Server
bun install --frozen-lockfile
bun run verify

cd ../Client
npm ci
npx playwright install --with-deps chromium
npm run verify
```

服务端验证失败时先修复类型或单元测试，再运行客户端；客户端 `verify` 当前依次执行 ESLint、Vitest 覆盖率、build、`test:e2e`（内部再次 build，再运行 Playwright 与歌词回归）。这些是现有脚本行为；局部验证使用上表命令，不额外重复执行完整链路。

网易云音乐 API 的缓存、频率限制、Cookie 隔离、真实请求测试和接口文档见
[`Agents/NeteaseMusicApi.md`](NeteaseMusicApi.md)。

## E2E 假红排查（本地）

`npm run test:e2e` 报 `Error: Timed out waiting 60000ms from config.webServer.` 时，
先检查进程输出和实际探活响应；若手动访问正常，再核对代理环境。以下是历史复现条件，不代表所有超时均由代理造成：

| 现象 | 真因 |
|---|---|
| 报 webServer 60 秒超时，但手动访问 `127.0.0.1:5173` 明明是 200 | 会话里存在 `HTTP_PROXY` / `HTTPS_PROXY`。Playwright 的就绪探测**会走代理**，拿到 502/404 而非真实响应；而 Node 的 `fetch` 默认**不读** `HTTP_PROXY`，所以手动探针会给出「一切正常」的误导结论。 |
| 日志里 BAKA 服务反复打印 `HTTP GET /` 与 `/index.html` 的 404 | 那是被代理转发过来的**就绪探测请求**，不是页面请求。`playwright.config.ts` 中「Windows 双栈导致 404/超时」的注释记录的是同类现象。 |

处置：仅在确认代理误路由后，在当前测试子进程内移除 `HTTP_PROXY` / `HTTPS_PROXY`（含小写形式），测试结束恢复；不要更改用户的全局网络配置。保持 preview 的 `127.0.0.1` 硬绑定。

诊断利器：`DEBUG=pw:webserver npx playwright test` 会逐次打印探测 URL 与收到的状态码，
一眼能看出 404/502 是谁回的。

## Worker 异步错误断言

- 该变通最初在 Windows 的 Bun 1.3.x 上确立：对已初始化 Worker 的异步错误回包直接使用
  `expect(promise).rejects` 会阻塞消息分发。
  相关集成测试必须先通过原生 Promise 捕获结果，再同步断言明确业务错误码；禁止延长超时掩盖挂起。
- bun pin 升到 1.4.2 后（2026-09-22），**该变通保留且全量测试仍绿**；未单独验证移除后是否仍会挂起，
  因此不得以「版本已升」为由删除该写法。
