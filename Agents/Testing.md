# 测试体系

选择验证范围、编写测试或修改 CI 时查阅本文。先用下表确定需要的检查，再阅读对应层级；排障章节只在出现相关症状时使用。命令分别在 `Server/`（Bun）和 `Client/`（Node/npm）内执行。

## 验证范围

| 改动类型 | 完成所需的验证 |
|---|---|
| 纯文档或注释 | 检查 diff、链接、引用路径、命令与规则一致性；不运行无关业务套件 |
| 局部服务端行为 | 相关 `bun test` 文件 + `bun run check`；新增行为或缺陷补有判别力的回归 |
| 局部客户端逻辑 | 相关 Vitest 文件 + `npm run lint` + `npm run build` |
| 页面样式或动效 | lint、build 与受影响页面浏览器验证；按 Design / Animation 检查相关状态及视口，不为样式类新增镜像单测 |
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

以下事项属于后续容量或维护工作，目前没有伪装成已完成的门禁：拆分过大的 E2E 文件、长连接稳定性与断线矩阵、夜间真实第三方集成、持续容量趋势报告，以及按模块设置更细粒度的覆盖率阈值。新增测试应先补齐对应行为和夹具，再考虑把它们纳入 CI。

## 测试分层

| 层级 | 位置 | 运行器 | 主要职责 |
|---|---|---|---|
| 后端单元测试 | `Server/test/Rules.test.ts`、`ConnectionRegistry.test.ts`、`WordBankRepository.test.ts`、`BangumiProvider.test.ts` | `bun:test` | 纯规则、连接筛选、错误码、广播隔离、词库去重与并发持久化、Bangumi 图片重写与请求缓存 |
| 后端服务回归 | `Server/test/WhoIsFakerService.test.ts`、`TestRoom.test.ts`、`SonGuessrService.test.ts`、`CCBService.test.ts` | `bun:test` | 状态机、会话重连、房主宽限、角色限制、测试房间、SonGuessr 歌曲与番剧流程、CCB 房间生命周期与清理、人机 |
| 协议与传输集成 | `Server/test/WhoIsFakerProtocol.test.ts`、`App.test.ts`、`CommandHandlers.test.ts`、`SonGuessrProtocol.test.ts`、`NeteaseMusicProvider.test.ts` | `bun:test` | 消息解析、OpenAPI、HTTP、CORS、真实 WebSocket、命令分发、SonGuessr 协议、网易云与 Bangumi 接口 Mock 与解析 |
| 网络承载回归 | `Server/test/NetworkCapacity.test.ts`、`StateSync.test.ts` | `bun:test` | 150 人 / 6 Mbps 容量预算、差量与全量同步 |
| 前端单元测试 | `Client/src/lib/*.test.ts`、`Client/src/hooks/*.test.tsx` | Vitest + jsdom | 会话存储、日志解析、发言列、WebSocket 客户端、自定义 Hook |
| 前端集成回归 | `Client/src/stores/*.test.ts`、`Client/src/App.test.tsx` | Vitest + Testing Library | Zustand 与 WS 联动、标签页替换、路由回退 |
| 端到端测试 | `Client/e2e/*.spec.ts` | Playwright | 落地页、大厅、移动端、双浏览器真实房间流程 |

## 常用命令

服务端：

```bash
cd Server
bun test
bun run test:coverage
bun run test:production-smoke
bun run verify
bun test test/NetworkCapacity.test.ts
bun test test/BangumiProvider.test.ts test/SonGuessrService.test.ts

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
- Playwright 自动启动服务端与 Vite；使用 `http://localhost:4850/health` 进行服务端健康检查探活，前端监听 `localhost:5173`。

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
- 歌词几何与动效测试使用 `e2e/SongLyrics.config.ts` 单独启动 Vite（5177），真实挂载 AMLL 与生产 CSS，只替代媒体解码与房间传输。测试入口仅在 `e2e/fixtures/`，不进入生产构建。必须检查首末行边界、字号和宽度变化、首次可见帧、完成与重播的中间帧；不得以手工估算高度的 jsdom 断言代替浏览器验证。

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
