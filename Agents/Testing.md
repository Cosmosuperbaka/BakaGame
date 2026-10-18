# 测试体系

选择验证范围、编写测试或修改 CI 时查阅本文。先用下表确定需要的检查，再阅读对应层级；排障章节只在出现相关症状时使用。命令分别在 `Server/`（Bun）和 `Client/`（Node/npm）内执行。

| 工作范围 | 查阅位置 |
|---|---|
| 确定本次改动要跑什么 | 「验证范围」 |
| CI 必须维持的门禁 | 「门禁与真相源」 |
| 测试分层与文件位置 | 「测试分层」 |
| 命令、依赖与浏览器 | 「常用命令」「依赖与浏览器」 |
| 编写与维护测试 | 「测试编写与维护」 |
| 领域专项验收与组件截图 | 「领域专项验收」「组件截图」 |
| 发布前完整回归 | 「CI 推荐顺序」 |
| 本地假红与异步断言排障 | 「E2E 假红排查」「Worker 异步错误断言」 |

## 验证范围

| 改动类型 | 完成所需的验证 |
|---|---|
| 纯文档或注释 | 检查 diff、链接、引用路径、命令与规则一致性；运行 `node scripts/CheckDocs.mjs`；不运行无关业务套件 |
| 局部服务端行为 | 相关 `bun test` 文件 + `bun run check` + `bun run lint`；新增行为或缺陷补有判别力的回归 |
| 局部客户端逻辑 | 相关 Vitest 文件 + `npm run lint` + `npm run build` |
| 页面样式或动效 | lint、build 与受影响页面浏览器验证；按 Design / Animation 检查相关状态及视口，不为样式类新增镜像单测；受影响组件的故事同步更新，用 `storybook:shots --filter` 做改前改后截图对照 |
| Storybook 故事、假数据或截图工具 | `npx tsc -p tsconfig.app.json --noEmit`、lint、`npm run build-storybook`，相关故事 `storybook:shots` 零失败、零控制台错误 |
| 共享协议、跨游戏基础设施、全局状态同步 | 两端类型/构建与相关协议、Store、服务回归；涉及握手或路由时验证真实命令 ACK |
| HTTP 路由或接口契约 | 两端类型检查与相关协议回归；在 Server 执行 `bun run docs:openapi` 并提交 `Agents/http-openapi.json`。契约面（过程清单、`meta.auth` 对应的 401/403、请求与响应的 `json` 包络）由 `Server/test/RpcOpenapi.test.ts` 打真实路由核对，产物与代码不同步时该文件的在库比对断言报红 |
| 快照、私有状态、封包或广播频率 | `Server/test/NetworkCapacity.test.ts`，保留全部容量与最终同步断言 |
| 歌词几何、字体或动画 | `npm run test:lyrics`；jsdom 高度模拟不替代真实浏览器 |
| 资源、构建插件或静态外壳 | `npm run test:asset-smoke` 与相关 SEO / 资源 E2E |
| 依赖或运行时升级 | 升级前后以同一组检查验证受影响包；Server check + test，Client lint + coverage + build；浏览器/构建依赖另跑相关 E2E，基础运行时或跨端影响覆盖两端 |
| 格式化或文件改名 | `pnpm format:check` + 两端 lint；改名同时核对 `knip.jsonc` 入口、`Agents/*.md` 路径引用与 CI 的文档检查 |
| CI、发布准备或明确要求完整回归 | 对应包 `verify`，发布另查 Deployment；服务启动/运维端点改动补 `test:production-smoke` |

本地单测和隔离冒烟可直接运行、修复本次引入的失败并重跑。通过后不重复扩大检查；新改动、失败或未消除风险才增加验证。全量 CI 门禁继续执行，不要求每个局部编辑都先跑完整 CI。

### Lint 基线与复杂度门禁

两端使用同一套规则面：`@eslint/js` recommended + `typescript-eslint` recommended + `eslint-plugin-sonarjs`
（`sonarjs/cognitive-complexity`，阈值 20）+ 七条缺陷类 type-aware 规则
（`no-floating-promises`、`no-misused-promises`、`await-thenable`、`no-base-to-string`、
`only-throw-error`、`prefer-promise-reject-errors`、`unbound-method`）。

- **Client** 的类型感知只对 `src/**` 开启，`parserOptions.project` 必须显式指向 `./tsconfig.app.json`：
  根 `tsconfig.json` 是 `files: []` + references，`projectService` 会撞上它并报 file not found。
  e2e、`.storybook` 与构建配置不在该工程内，只走语法级检查。
- **Server** 的类型感知用 `projectService`，覆盖 `src` / `scripts` / `test`；`integration` 与
  `drizzle.config.ts` 不在 tsconfig 工程内，只走语法级检查。`test/**` 额外关闭
  `await-thenable` 与 `no-explicit-any`：夹具多为同步函数、桩多为 `any`，按生产标准要求只会产生噪声。
- **`pnpm lint` 消费 TS 6 的程序化 API，`pnpm check` / `build` 用 TS 7 的 `tsc`**：两条线版本不同，失败也分属两端——类型感知规则崩掉（`tsutils.unionConstituents is not a function`）只在 lint 出现，lib 收紧的类型错误（`Uint8Array<ArrayBuffer>` 不再赋给 `ArrayBufferView<ArrayBuffer>`）只在 check 出现。动 `typescript` 依赖或根 override 后两端都要重跑，不看一端绿就收工；版本口径见 [Conventions](Conventions.md#依赖版本约束升级前必读)。
- **存量用基线文件记录，不用内联注释**：`Client/eslint-suppressions.json` 与
  `Server/eslint-suppressions.json` 是 ESLint bulk suppressions 的按「文件 + 规则 + 计数」账本。
  新增违规直接失败；重构导致计数下降后会报 unused suppressions，此时跑 `pnpm lint:prune` 递减基线并一并提交。
- 只有**刻意的设计**才允许就地 `eslint-disable-next-line`，且必须写明理由（示例见
  `Client/src/components/songuessr/layout/VolumeControl.tsx` 的静音收束）。
- 改规则、改阈值或改 lint 覆盖范围时，必须同批重跑 `pnpm lint`、更新两端基线文件，并确认
  `pnpm knip` 仍然零问题（新增 lint 依赖必须被 `eslint.config.js` 直接 import）。

普通测试使用隔离夹具与 Mock 上游；真实网易云测试单独调用，会使用本地凭据。按已有授权和 [NeteaseMusicApi](NeteaseMusicApi.md#测试要求) 执行，不把它当普通单测。环境缺失时记录未验证范围，不用改低阈值或伪造通过来交付。

### 格式化与文件名

- 格式化器是根级 **Prettier**（`prettier.config.mjs`）：`pnpm format` 写入，`pnpm format:check` 只校验。CI 的 `Knip` 作业在建依赖后先跑 `format:check`，再跑 `knip`。
- **`endOfLine: "auto"` 不许改**：工作区是 CRLF、CI 检出是 LF，`auto` 保留每个文件原样；改成 `lf`/`crlf` 会让另一端起整文件级 diff。
- 忽略范围在 `.prettierignore`：文档与 `tasks/`、构建产物、`Server/data`、`Server/drizzle` 迁移、E2E 的 HTML 夹具都不参与格式化。
- 文件名由 `check-file/filename-naming-convention` 强制 PascalCase，必须开 `ignoreMiddleExtensions`（否则 `X.test.tsx`、`X.stories.tsx` 的中缀段会被判违规）；`Client/src/vite-env.d.ts` 是唯一豁免，`vite.config.ts`、`playwright.config.ts` 这类配置不在规则 glob 内。
- 格式化改动单独提交（`style(Core):` 前缀），不要和业务改动混在一起；改名或换大小写时同步 `knip.jsonc` 入口与 `Agents/*.md` 里的路径引用。

## 门禁与真相源

必须维持的门禁：

- 测试命令与验证矩阵只在本文维护；专项文档只写「验收要点」，不复制命令、测试文件名或逐用例清单。

- 服务测试不连接真实数据库：仓储为可选注入，未注入即不落库（见 [Database](Database.md#5-测试)）；结算流程和资源路径均有回归覆盖。
- 客户端生产构建后执行资源冒烟，检查入口 HTML、固定 WebP、哈希贴纸、SPA 路由和 MIME。
- 服务端与客户端覆盖率命令必须留在 CI。阈值只在 [CheckCoverage.ts](../Server/scripts/CheckCoverage.ts) 与 [vitest.config.ts](../Client/vitest.config.ts) 维护，本文不复制易过期的数值。CI 须保留两端 lcov/HTML 报告。
- `Server/scripts/ProductionSmoke.ts` 启动真实服务进程，检查 `/health`、`/livez`、`/readyz` 以及 WhoIsFaker、SonGuessr、CEE 三个 WebSocket 入口的大厅订阅 ACK；使用隔离端口和无网络上游，不访问真实第三方。
- 聊天气泡使用 `data-testid="chat-message-bubble"`，E2E 不得读取 Tailwind 类名；关键落地页和聊天流程须把页面异常、控制台错误及非预期 4xx 转为测试失败。
- 客户端 CI 在生产构建后执行 `npm run build-storybook`，防止故事与截图工具随组件改动失效。
- 文档门禁 `node scripts/CheckDocs.mjs` 校验根文档与 `Agents/` 的相对链接、锚点，以及 `Agents/` 每篇文档是否已在 `AGENTS.md` 导航表中登记；CI 的 Docs Check 作业无条件执行，纯文档改动同样受约束。
- 静态分析门禁 `pnpm knip`（根级，配置 `knip.jsonc`）检查未使用的文件、依赖、导出与类型：文件、依赖、未声明依赖、未解析导入为 `error`，导出与类型为 `warn`（只提示不阻断）。入口（测试、故事、E2E、`bun --preload` 夹具）在配置里显式声明，不要用忽略清单掩盖真实问题。Knip 会加载 `Client/vite.config.ts`，而配置加载只读不写盘（WebP 目录重建在插件的 `config` 钩子里），因此本机与 CI 都不需要删除豁免开关。

以下能力尚未纳入门禁，不得按已覆盖对待：拆分过大的 E2E 文件、长连接稳定性与断线矩阵、夜间真实第三方集成、持续容量趋势报告，以及按模块设置更细粒度的覆盖率阈值。新增测试应先补齐对应行为和夹具，再考虑把它们纳入 CI。

## 测试分层

| 层级 | 位置 | 运行器 | 主要职责 |
|---|---|---|---|
| 后端单元测试 | `Server/test/` 下的规则、连接、Bangumi Provider 系列 | `bun:test` | 纯规则、连接筛选、错误码、广播隔离、Bangumi 本地数据与远端回退、远端请求截止/排队与 Worker 缓存/图片重写 |
| 后端服务回归 | `Server/test/` 下的 WhoIsFaker、SonGuessr、CEE 服务套件 | `bun:test` | 状态机、会话重连、房主宽限、角色限制、测试房间、SonGuessr 歌曲与番剧流程、CEE 原生房间生命周期、模式与边界、原版互通服务与回合 |
| 协议与传输集成 | `Server/test/` 下的协议、App、命令分发与 Provider 套件 | `bun:test` | 消息解析、OpenAPI、HTTP、CORS、真实 WebSocket、命令分发、SonGuessr 协议、网易云接口 Mock 与解析、CEE 协议与 WebSocket 传输及原版协议 |
| 账号与鉴权 | `Server/test/` 的账号、用户数据、管理与统计套件（夹具 `AccountFixtures.ts`） | `bun:test` | Better Auth 内存适配器下的验证码登录、端点白名单、发码限流、投递失败、管理员引导、资料隐私与头像缓存；设置云同步与站内反馈；管理接口与审计；前端对应单测见 [Account](Account.md#10-验收要点) |
| 对局记录 | `Server/test/` 的记录与 SonGuessr 服务套件 | `bun:test` | 记录服务的房间聚合、失败隔离、截断与重复/迟到回合忽略，三款游戏结算各写一个回合（见 [GameRecord](GameRecord.md#4-验收要点)） |
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
# CEE：按原生服务、协议传输、原版互通链路分别选择
bun test test/CEENativeLifecycle.test.ts test/CEENativeModes.test.ts test/CEENativeBoundaries.test.ts test/CEERules.test.ts
bun test test/CEEProtocol.test.ts test/CEETransport.test.ts
bun test test/CEEOriginalService.test.ts test/CEEOriginalRounds.test.ts test/CEEOriginalProtocol.test.ts

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

- 依赖安装、锁文件与提升布局统一以 [Conventions §4](Conventions.md) 为准：入口只有仓库根的 `pnpm install`（CI 用 `--frozen-lockfile`），Server 下没有 `node_modules`，依赖包内附带的数据文件必须用模块解析定位。
- Windows 本地 Playwright 默认复用系统 Microsoft Edge 的 Chromium 内核。
- 其他平台或 CI 先运行 `npx playwright install --with-deps chromium`。
- 常规 Playwright 自动启动服务端与生产 `vite preview`：后端探活 `http://127.0.0.1:4850/health`，前端探活 `http://127.0.0.1:5173`，页面基址 `http://127.0.0.1:5173`。单独运行 Playwright 前先构建；`test:e2e` 已包含 build。歌词套件另用 Vite 5177。

### 客户端 E2E 隔离边界

- 常规浏览器回归先用 `node scripts/e2e-build.mjs` 构建，再执行 `playwright test`。入口跨平台调用已安装的 TypeScript/Vite，不经 shell 拼接；Vite `envDir: false` 禁止加载 `.env`，显式设置 `VITE_SENTRY_DSN` 为空、`VITE_SERVER_URL=http://127.0.0.1:4850`。`NODE_ENV` 与 mode 仍为 production，不绕过仅生产生效的行为。
- App/CEE/SEO/歌词 统一导入 `e2e/fixtures/Isolation.ts`；默认 context 自动装守卫，额外参与者使用 `isolatedContext` fixture，不裸调 `browser.newContext`。创建页面前安装 HTTP/WS route，仅允许 localhost、IPv4 loopback 与 `::1`，外部连接 abort/close 且在 teardown 明确失败；默认和额外 context 均禁用 Service Worker。允许的 HTTP 请求由 `route.fetch({ maxRedirects: 0 })` 取回再 fulfill；带 Location 的 HTTP 重定向明确失败，不让浏览器在只拦首跳的路由机制下隐式外跳。
- Edge/Chromium 的 Local Network Access 权限只授予当前套件回环 `baseURL` 的 origin（应用 5173、歌词 5177），用于本地 WS 路由桥；所有默认及手动 context 均使用同一范围，不禁用浏览器安全，也不授权外部来源。
- 页级合成夹具不得通过 `route.continue()` 绕过 context 守卫，未命中用 `fallback()`。CEE 可选图片只能本地合成 fulfill，WS 图片夹具只匹配 loopback，不能接通真实上游。原有页面异常、控制台及非预期 HTTP 错误质量断言保留。网易云登录二维码在浏览器边界仅替换创建/轮询 ACK，使用不可扫描的合成图片；房间命令透传真实隔离服务，保留可见、图片加载和恰好一次创建断言，不以开放真实出口让登录测试通过。
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
- 生产服务冒烟保持隔离、可重复且不访问第三方；真实第三方集成单独运行、输出脱敏，不进入常规 CI。真实角色 E2E 检出时需按 R2 manifest 拉取数据实体（见 [Server/data/README.md](../Server/data/README.md)）。

## 领域专项验收

- CEE 网络容量使用真实原生服务与生产 `StateSyncEncoder`，以 150 名玩家、每秒 12 次猜测、持续
  60 秒以及公共/私有两通道的全量校准计量，连同请求、ACK、WebSocket 帧及 15% 余量不超过
  6 Mbps。必须断言实际产生补丁，不能只检查事件登记或跳过未变化的校准流量。
- CEE 图片提示用生成的栅格图片经过真实 sharp 解码、缩放、模糊及 WebP 编码，校验像素尺寸和
  模糊后方差下降；下载失败、无效地址、损坏图片统一返回业务错误，流式超限及时取消，失败不得
  留在成功缓存或阻塞后续同键请求。图片测试不访问真实上游。
- 歌词几何与动效测试使用 `e2e/SongLyrics.config.ts` 和隔离配置 `Client/e2e/SongLyrics.vite.ts` 单独启动 Vite（5177；独立依赖缓存，不运行应用资源预处理、不写 `.generated-public/` 或 `dist/`），真实挂载 AMLL 与生产 CSS，只替代媒体解码与房间传输。测试入口仅在 `e2e/fixtures/`，不进入生产构建。必须检查首末行边界、字号和宽度变化、首次可见帧、完成与重播的中间帧；不得以手工估算高度的 jsdom 断言代替浏览器验证。

## 组件截图（Storybook）

用于样式审查与改前改后对照，不做像素断言，也不替代 E2E 与单测。

- 故事与组件同目录（`Foo.stories.tsx`），标题按 `基础控件`、`公共组件`、`页面`、`谁是卧底`、`猜歌`、`CEE` 分组，故事名写中文状态。假数据放 `src/stories/fixtures/`，按共享类型构造且与真实业务口径一致；文案同样遵守 [Design §1](Design.md)。
- 连 Store 的组件在 `beforeEach` 用 `src/stories/StorePresets.ts` 预置状态；预览层在每个故事前把全部 Store 复位。故事不得渲染 `layouts/`、`contexts/` 或调用 `init*Ws`，不访问外网：图片用本地资源或数据 URL，截止时间在运行时用 `fromNow` 计算。
- 截图规则由 tags 决定：`page` 整页 × 手机 390 / 平板 900 / 桌面 1440；`overlay` 含 Portal 的整页 × 手机 / 桌面；`mobile` 只拍手机宽度；`no-shot` 不拍；其余按故事根元素取景。每种都出亮、暗两套；暗色只用于样式检查，站内不开放。
- `storybook:shots` 自启独立端口的 Storybook（`--url` 可复用已运行的实例），关闭 framer-motion 过渡并模拟减弱动效，等字体、图片与动画落定后截图。故事渲染失败、页面异常或控制台错误令命令以非零退出。`--filter` 只重拍匹配的故事，索引保留其余故事的上次结果；`--out` 另存一份用于对照。
- 截图基本可复现：「当前时间」固定为脚本里的 `FIXED_NOW`（计时器照常运行，倒计时与相对时间每次都一样），动图（GIF、APNG、动态 WebP）换成首帧静态图，浏览器以同步解码、绘制前完成光栅的软件渲染启动。同一代码两次截图之间只剩少数图片边缘像素、通道差不超过个位数的抗锯齿抖动，因此改前改后对照要按容差比较或目视，不能只比文件哈希。新增故事若两次截图差异明显，先排查其中的随机数、真实时间或外部资源。
- `npm run storybook`、`build-storybook` 与应用的 dev/build 一样会重建 `.generated-public/`，不要与其它 Vite 进程并行启动。

## CI 推荐顺序

```bash
# 仓库根：安装由 pnpm 统一完成（锁文件 = pnpm-lock.yaml）
pnpm install --frozen-lockfile

# 仓库根：静态分析（未使用文件、依赖、导出；导出/类型只提示，见 knip.jsonc）
pnpm knip

# Server：pnpm 只转发，运行时仍是 Bun
pnpm --filter server verify          # = lint + check + test:coverage

# Client：Node 工具链
pnpm --filter client verify          # = lint + test:coverage + build + test:e2e
```

服务端验证失败时先修复类型或单元测试，再运行客户端；两端 `verify` 都先跑 ESLint（Server 为 lint → check → 覆盖率，Client 为 lint → 覆盖率 → build → `test:e2e`），再进入各自的构建与回归。这些是现有脚本行为；局部验证使用上表命令，不额外重复执行完整链路。

网易云音乐 API 的缓存、频率限制、Cookie 隔离、真实请求测试和接口文档见
[`Agents/NeteaseMusicApi.md`](NeteaseMusicApi.md)。

## E2E 假红排查（本地）

`npm run test:e2e` 报 `Error: Timed out waiting 60000ms from config.webServer.` 时，
先检查进程输出和实际探活响应；若手动访问正常，再核对代理环境。下表用于判定代理误路由，不代表所有超时均由代理造成：

| 现象 | 真因 |
|---|---|
| 报 webServer 60 秒超时，但手动访问 `127.0.0.1:5173` 明明是 200 | 会话里存在 `HTTP_PROXY` / `HTTPS_PROXY`。Playwright 的就绪探测**会走代理**，拿到 502/404 而非真实响应；而 Node 的 `fetch` 默认**不读** `HTTP_PROXY`，所以手动探针会给出「一切正常」的误导结论。 |
| 日志里 BAKA 服务反复打印 `HTTP GET /` 与 `/index.html` 的 404 | 那是被代理转发过来的**就绪探测请求**，不是页面请求。`playwright.config.ts` 中「Windows 双栈导致 404/超时」的注释记录的是同类现象。 |

处置：仅在确认代理误路由后，在当前测试子进程内移除 `HTTP_PROXY` / `HTTPS_PROXY`（含小写形式），测试结束恢复；不要更改用户的全局网络配置。保持 preview 的 `127.0.0.1` 硬绑定。

诊断利器：`DEBUG=pw:webserver npx playwright test` 会逐次打印探测 URL 与收到的状态码，
一眼能看出 404/502 是谁回的。

## Worker 异步错误断言

- 对已初始化 Worker 的异步错误回包，**不得直接使用** `expect(promise).rejects`：它会阻塞消息分发。
  相关集成测试必须先通过原生 Promise 捕获结果，再同步断言明确业务错误码；禁止延长超时掩盖挂起。
- 该写法不随 Bun 版本升级失效，**不得以「版本已升」为由删除**；要移除它必须先单独验证不再挂起。
