# 测试体系

本项目没有根级 `package.json`。服务端和客户端是两个独立包，验证时必须分别进入对应目录。

## 测试分层

| 层级 | 位置 | 运行器 | 主要职责 |
|---|---|---|---|
| 后端单元测试 | `Server/test/Rules.test.ts`、`ConnectionRegistry.test.ts`、`WordBankRepository.test.ts` | `bun:test` | 纯规则、连接筛选、错误码、广播隔离、词库去重与并发持久化 |
| 后端服务回归 | `Server/test/RoomService.test.ts`、`TestRoom.test.ts`、`SonGuessrService.test.ts` | `bun:test` | 状态机、会话重连、房主宽限、角色限制、测试房间、SonGuessr 游戏流程与人机 |
| 协议与传输集成 | `Server/test/ProtocolOpenapi.test.ts`、`App.test.ts`、`CommandHandlers.test.ts`、`SonGuessrProtocol.test.ts`、`NeteaseMusicProvider.test.ts` | `bun:test` | 消息解析、OpenAPI、HTTP、CORS、真实 WebSocket、命令分发、SonGuessr 协议、网易云音乐接口 Mock 与解析 |
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
bun run verify
bun test test/NetworkCapacity.test.ts

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
bun test test/RoomService.test.ts

cd Client
npx vitest run src/lib/WebsocketClient.test.ts
npx playwright test e2e/app.spec.ts
```

## 依赖与浏览器

- 服务端只使用 `Server/bun.lock`，安装时运行 `bun install --frozen-lockfile`。
- 客户端只使用 `Client/package-lock.json`，安装时运行 `npm ci`。
- Windows 本地 Playwright 默认复用系统 Microsoft Edge 的 Chromium 内核。
- 其他平台或 CI 先运行 `npx playwright install --with-deps chromium`。
- Playwright 自动启动服务端与 Vite；使用 `http://localhost:4850/health` 进行服务端健康检查探活，前端监听 `localhost:5173`。

## 编写约定

- 修复缺陷时至少补一条能在修复前失败的回归测试。
- 业务状态机优先从 `RoomService.execute` 真实入口测试，不直接调用私有实现。
- 纯规则和连接注册表使用无网络的单元测试；HTTP/WS 交互放在 `App.test.ts` 或 Playwright。
- 每条测试独立创建房间、连接与临时目录，禁止依赖用例顺序。
- Vitest 测试只放在 `Client/src`；Playwright 测试只放在 `Client/e2e`。
- 覆盖率用于识别空白区域，不以低价值断言追求全局百分比。新增核心逻辑必须覆盖主要分支。
- **行为驱动而非细节绑定**：UI 组件与页面单测绑定 ARIA 角色、语义文本与数据契约，严禁断言特定 Tailwind 原子类名或 DOM 深度层级；E2E 严禁对页面外壳进行 class 字符串全等比对。
- **异常强断言铁律**：严禁使用裸 `toThrow()`，必须断言明确的业务错误码（如 `code: "INVALID_ROOM_ID"`）或关键错误描述。
- **状态驱动而非过度 Mock**：Zustand 状态测试使用 `store.setState(...)` 原生注入真实状态上下文，严禁模块级 `vi.mock` 替换全局 Store。
- **依赖注入与无网络时钟**：包含退避、冷却、抖动的类与服务（如 `NeteaseMusicProvider`）必须构造器注入 `now` 与 `random`，以虚拟时钟进行 0ms 确定性测试；遥测打点等外部 IO 必须参数化注入 `fetcher`，禁止单测滥用 `vi.stubGlobal("fetch")`。
- **杜绝镜像测试文件**：文件重命名或重构后必须同步清理旧镜像单测文件，严禁双胞胎测试共存。

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
