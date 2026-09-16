# 测试体系

本项目没有根级 `package.json`。服务端和客户端是两个独立包，验证时必须分别进入对应目录。

本文件同时维护覆盖矩阵、生产资源冒烟、过时测试治理、CI 门禁，以及未来新增测试的质量要求。

## 优化实施状态

本轮测试套件优化已经落地以下门禁：

- 测试夹具在清理临时目录前会排空词库异步写队列；结算流程和资源路径均有回归覆盖。
- 客户端生产构建后执行资源冒烟，检查入口 HTML、固定 WebP、哈希贴纸、SPA 路由和 MIME。
- 服务端与客户端覆盖率命令已进入 CI。服务端检查函数覆盖率至少 92.87%、行覆盖率至少 95.45%；客户端检查语句 54%、分支 43%、函数 45%、行 56%。CI 会保留两端 lcov/HTML 报告。
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

## 编写约定

- 修复缺陷时至少补一条能在修复前失败的回归测试。
- 业务状态机优先从 `WhoIsFakerService.execute` 等真实入口测试，不直接调用私有实现。
- 纯规则和连接注册表使用无网络的单元测试；HTTP/WS 交互放在 `App.test.ts` 或 Playwright。
- 每条测试独立创建房间、连接与临时目录，禁止依赖用例顺序。
- Vitest 测试只放在 `Client/src`；Playwright 测试只放在 `Client/e2e`。
- 覆盖率用于识别空白区域，不以低价值断言追求全局百分比。新增核心逻辑必须覆盖主要分支。
- **行为驱动而非细节绑定**：UI 组件与页面单测绑定 ARIA 角色、语义文本与数据契约，严禁断言特定 Tailwind 原子类名或 DOM 深度层级；E2E 严禁对页面外壳进行 class 字符串全等比对。
- **异常强断言铁律**：严禁使用裸 `toThrow()`，必须断言明确的业务错误码（如 `code: "INVALID_ROOM_ID"`）或关键错误描述。
- **状态驱动而非过度 Mock**：Zustand 状态测试使用 `store.setState(...)` 原生注入真实状态上下文，严禁模块级 `vi.mock` 替换全局 Store。
- **依赖注入与无网络时钟**：包含退避、冷却、抖动的类与服务（如 `NeteaseMusicProvider`）必须构造器注入 `now` 与 `random`，以虚拟时钟进行 0ms 确定性测试；遥测打点等外部 IO 必须参数化注入 `fetcher`，禁止单测滥用 `vi.stubGlobal("fetch")`。
- **杜绝镜像测试文件**：文件重命名或重构后必须同步清理旧镜像单测文件，严禁双胞胎测试共存。
- **生产资源必须冒烟**：客户端生产构建后必须通过 preview 服务器检查入口 HTML、固定 WebP、所有哈希贴纸、SPA 路由和资源 MIME；只测试 Vite 插件函数不算资源验证。
- **异步夹具必须排空**：测试删除临时目录或关闭服务前，必须等待所有持久化写队列和异步任务结束；未处理 Promise rejection、console error 和非预期 4xx 必须令测试失败。
- **覆盖率必须进 CI**：`Server` 执行 `bun run test:coverage`，`Client` 执行 `npm run test:coverage`；覆盖率用于阻止回退，核心模块的主要分支不得以全局平均值掩盖。
- **开发服务器不代表生产**：Playwright 的资源冒烟使用 `npm run build` 后的 `vite preview`；真实房间 E2E 可以使用开发服务器，但必须另有生产构建冒烟。
- **覆盖率阈值必须可追溯**：修改阈值时必须同时说明基线、覆盖空白和回退风险；禁止为通过 CI 临时降低阈值。服务端阈值由 `Server/scripts/CheckCoverage.ts` 检查，客户端阈值由 `Client/vitest.config.ts` 检查。
- **生产冒烟必须隔离上游**：冒烟脚本只能验证本地服务、协议握手和关键 ACK；网易云、Bangumi 等真实第三方调用必须使用 Mock 或单独的凭据隔离集成任务。
- **E2E 质量监听必须可解释**：监听到的 `pageerror`、控制台 error 或 HTTP 4xx/5xx 必须能关联到当前用户流程；确属预期的状态码要在测试中显式白名单并写明原因。

## 新增测试质量规范

- 新功能和缺陷修复必须包含测试；缺陷回归测试应在修复前能够失败，并覆盖用户可观察的行为。
- 测试名称描述业务行为和结果，不描述 DOM 层级、样式类名或私有方法；禁止提交 `.only`、无理由 `.skip` 和镜像测试文件。
- 每个用例独立创建房间、连接、临时目录和数据；`afterEach` 必须关闭连接、排空异步写队列并清理临时资源。
- 状态机测试从公开服务入口执行；外部 IO、时钟、随机数通过构造器或参数注入，测试保持确定且无网络依赖。
- 失败断言必须检查错误码、HTTP 状态或关键字段；禁止裸 `toThrow()`、裸 truthy 断言和只验证调用次数的假测试。
- Zustand 测试使用 `store.setState` 注入状态；UI 测试优先使用 ARIA、语义文本和 `data-testid`，禁止绑定 Tailwind 类名或 DOM 深度。
- E2E 只覆盖跨页面、跨进程和真实用户风险；多浏览器上下文必须在 `finally` 中关闭，并确保测试输出没有未处理 rejection、console error 或非预期 4xx。
- 新增生产资源必须加入构建后 preview 冒烟，验证 HTTP 200、MIME、非空内容和可解码性；仅测试插件函数不合格。
- 覆盖率用于发现空白和防止回退；核心逻辑须覆盖主要分支，不得用低价值断言堆高全局百分比。真实第三方集成测试单独运行、凭据脱敏，不进入常规 CI。
- 生产服务冒烟应保持单进程、可重复和无外部网络依赖；端口、临时目录、WebSocket 和子进程必须在 `finally` 中释放，超时后应主动终止子进程。
- E2E 选择器优先使用 ARIA 角色、可见语义文本和稳定 `data-testid`。只有当元素本身就是业务契约时才增加 `data-testid`，不得把样式类名或 DOM 深度变成测试接口。

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

服务端验证失败时先修复类型或单元测试，再运行客户端；客户端 `verify` 的顺序是 ESLint、Vitest 覆盖率、生产构建、Playwright，便于尽早失败。

网易云音乐 API 的缓存、频率限制、Cookie 隔离、真实请求测试和接口文档见
[`Agents/NeteaseMusicApi.md`](NeteaseMusicApi.md)。
