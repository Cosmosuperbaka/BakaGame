# 工程规范与代码整洁度指南 (Conventions & Clean Code Guide)

本文档定义全栈代码库的命名一致性、目录结构、架构边界与重构准则，防止跨技术栈概念断层与风格割裂。

---

## 1. 命名规范 (Naming Conventions)

### 1.1 核心业务实体与专有名词常量命名

- **谁是卧底**: 全栈统一命名为 `WhoIsFaker`（缩写 `wif` 用于缓存/存储前缀如 `wif_session_`）。
- **猜歌游戏**: 全栈统一命名为 **`SonGuessr`（漏G版）**。
  - **TypeScript 类型/接口/类/变量**: 统一使用 `SonGuessr`（如 `SonGuessrService`, `SonGuessrRoomSnapshot`, `SonGuessrPrivateState`, `UseSonGuessrStore`, `SonGuessrProvider`）。严格以 `Agents/Spec.md` 为统一真相源，坚决杜绝保留 `SongGuessr...` 等过渡期别名与兼容导出。
  - **常量命名 (Constants)**：`SonGuessr` 为专有名词，常量一律使用 **`SONGUESSR_XXX`** 前缀（例如 `SONGUESSR_PHASES`, `SONGUESSR_MUSIC_SESSION_CHANGED`），严禁拆分为 `SON_GUESSR_`。
  - **URL 路由 / API 路径 / 存储命名空间**: 统一使用 `songuessr`（如 `/songuessr`, `/api/songuessr/ws`, `songuessr_session_`, `songuessr_netease_session_v1`）。
- **猜动漫角色增强版**: 全栈统一命名为 **`CCB`**（三个字母全大写，副标题「二刺猿笑传之猜猜呗」只作为页面对外展示文案，不进标识符）。
  - **TypeScript 类型/接口/类/变量**: 一律使用 **`CCB`** 缩写（`CCBService`、`CCBRoomSnapshot`、`CCBPrivateState`、`CCBPlayerRecord`、`parseCCBMessage`、`UseCCBStore`）。**严禁**写成 `CcbService`、`CcbRoom` 之类的混合大小写拼法；`ccbService` 这类以小写开头的局部变量与实例名按常规驼峰处理。
  - **常量命名 (Constants)**：一律使用 **`CCB_XXX`** 前缀（如 `CCB_PHASES`, `CCB_STATE_EVENTS`, `CCB_PLAYER_MESSAGE_LIMIT`）。
  - **URL 路由 / API 路径 / 存储命名空间**: 统一使用 `ccb`（如 `/ccb`、`/api/ccb/ws`、`ccb_session_`），ID 前缀同例（`ccb_player_`、`ccb_chat_`）。

### 1.2 文件与目录命名法则（全量大驼峰 PascalCase）

所有代码与测试文件统一使用**大驼峰命名法（PascalCase / UpperCamelCase）**：

| 文件类型 | 命名规则 | 示例 | 放置位置 |
|---|---|---|---|
| **TypeScript 核心模块** | `PascalCase.ts` | `WhoIsFakerService.ts`, `SonGuessrService.ts`, `StateSync.ts`, `Rules.ts`, `Index.ts` | `Server/src/application/`, `Server/src/transport/`, `Client/src/lib/` |
| **基础设施与仓储** | `PascalCase.ts` | `NeteaseMusicProvider.ts`, `WordBankRepository.ts`, `EventLogger.ts` | `Server/src/infrastructure/` |
| **自定义 Hooks** | `PascalCase.ts` (`Use*.ts`) | `UseAutoSave.ts`, `UseAutoScrollToBottom.ts`, `UseOriginTracker.ts` | `Client/src/hooks/` |
| **状态 Store** | `PascalCase.ts` (`Use*.ts`) | `UseWhoIsFakerStore.ts`, `UseSonGuessrStore.ts` | `Client/src/stores/` |
| **React Context** | `PascalCase.tsx` | `WhoIsFakerContext.tsx`, `SonGuessrContext.tsx` | `Client/src/contexts/` |
| **React 页面与组件** | `PascalCase.tsx` | `Main.tsx`, `WhoIsFakerRoomPage.tsx`, `SonGuessrRoomPage.tsx`, `PhaseHeader.tsx`, `EmojiPicker.tsx`, `Button.tsx` | `Client/src/pages/`, `Client/src/components/` |
| **测试与集成文件** | `PascalCase.test.ts(x)` | `WhoIsFakerService.test.ts`, `Rules.test.ts`, `UseWhoIsFakerStore.test.ts`, `UseAutoSave.test.tsx` | 与源文件同名放置在 `test/` 或源码同级 |

---

## 2. 目录架构与职责划分 (Directory Structure)

### 2.1 前端目录结构 (`Client/src/`)

```
Client/src/
├── components/
│   ├── common/              # 跨游戏复用组件（ChatPanel.tsx, PlayerStatusPill.tsx, PhaseHeader.tsx, EmojiPicker.tsx, CreateRoomDialog.tsx 等）
│   ├── whoisfaker/
│   │   ├── phases/          # 谁是卧底各阶段内容（WaitingPhase.tsx, DescriptionPhase.tsx, VotingPhase.tsx 等）
│   │   └── layout/          # 房间布局与专属组件（GameArea.tsx, PlayerList.tsx, TestController.tsx 等）
│   ├── songuessr/           # 猜歌游戏专属组件（PlayerList.tsx, SongSearchDialog.tsx, BangumiSearchDialog.tsx 等）
│   └── ui/                  # 基础 UI 原子组件（Button.tsx, Input.tsx, Dialog.tsx 等）
├── config/                  # 领域视觉与静态配置（WhoIsFakerPresentation.ts, Constants.ts）
├── contexts/                # 顶层 Context 与 Socket 生命周期连接器
├── hooks/                   # 纯 React 自定义 Hooks（UseAutoSave.ts 等）
├── lib/                     # 客户端底层通讯、存储与状态工具（Storage.ts, WhoIsFakerWs.ts, SonGuessrWs.ts）
├── pages/                   # 路由页面（LandingPage.tsx, WhoIsFakerPage.tsx, WhoIsFakerRoomPage.tsx, SonGuessrPage.tsx, SonGuessrRoomPage.tsx）
├── stores/                  # Zustand 状态管理（UseWhoIsFakerStore.ts, UseSonGuessrStore.ts）
├── types/                   # 统一导出 @bakagame/shared 契约（Index.ts）
└── Main.tsx                 # 客户端应用入口
```

### 2.2 后端目录结构 (`Server/src/`)

```
Server/src/
├── application/             # 领域编排服务与指令处理器
│   ├── handlers/            # 命令处理器（CommandHandler.ts, GameCommandHandler.ts, PlayerCommandHandler.ts 等）
│   ├── ConnectionRegistry.ts# 连接池注册表
│   ├── WhoIsFakerService.ts # 谁是卧底核心业务服务
│   └── SonGuessrService.ts  # 猜歌游戏核心业务服务
├── config/                  # 后端配置与常量（Constants.ts, Env.ts）
├── domain/                  # 纯业务规则、错误与领域定义（Rules.ts, Errors.ts, Model.ts）
├── infrastructure/          # 外部适配器与持久化仓储（NeteaseMusicProvider.ts, WordBankRepository.ts, EventLogger.ts）
├── shared/                  # 前后端强契约共享单源（Protocol.ts, Model.ts, SonGuessr.ts, Index.ts）
├── transport/               # 网络层与路由定义（App.ts, StateSync.ts, SonGuessrProtocol.ts, routes/System.ts）
└── Index.ts                 # 服务端应用入口
```

---

## 3. 跨端契约与状态流向准则 (Cross-Stack & State Rules)

1. **强类型共享契约**:
   - `Server/src/shared/Index.ts` 是全项目唯一的类型真相源。
   - 前端通过 `tsconfig.app.json` paths 和 `vite.config.ts` alias `@bakagame/shared` 引用。绝对禁止在 `package.json` 中引入 `file:../` npm 符号链接。
2. **命令查询职责分离 (CQS)**:
   - 状态 Store 中的 `setSnapshot` 必须作为处理服务端快照的领域 Reducer（包含阶段延迟展示、淘汰动效保护与聊天合并）。
   - 禁止在业务组件中直接绕过服务层推断私有权限或覆盖服务端快照。
3. **高内聚低耦合的组件拆分**:
   - 表单弹窗（如 `CreateRoomDialog.tsx`）只负责数据采集与校验回调，禁止隐式绑定具体业务 Store。
   - 跨游戏复用的视觉基建统一收口到 `components/common/` 与 `hooks/`。

---

## 4. 工作区架构与运行环境 (Workspace Structure & Runtime)

本项目由两个完全独立的包组成，**没有根目录级的 package.json 或共享脚本**：

| 包名 | 运行时 / 包管理器 | 源码目录 | 默认端口 |
|---|---|---|---|
| `WhoIsFaker_Server` | Bun (`bun:test`, `Bun.env`, `Bun.sleep`) | `Server/` | `4850` |
| `whoisfaker-client` | Node / npm (Vite, React 19, Vitest) | `Client/` | `5173` |

### 共享协议与契约映射机制 (`@bakagame/shared`)
- **单一真相源位置**：全库的共享定义统一位于 `Server/src/shared/`（`Model.ts` + `Protocol.ts` + `SonGuessr.ts`），两端共用同一份代码实体。
- **服务端引入方式**：通过相对路径 `../shared/Index` 引入，并通过 `Server/src/domain/Model.ts` 重新导出。部署时仅挂载 `Server/` 作为应用根目录，因此其引用的所有模块必须物理位于该目录内部。
- **客户端双映射同步**：前端使用 `@bakagame/shared` 规范说明符，必须在两个位置严格保持同步映射：
  1. `Client/tsconfig.app.json` 中的 `compilerOptions.paths`（供 `tsc` 类型检查器识别）。
  2. `Client/vite.config.ts` 中的 `resolve.alias`（供 Vite/Rolldown 打包器解析）。
  *注：Vite 不会自动读取 tsconfig paths，若仅修改一处会导致本地或生产构建隐蔽失败。*
- **严禁重新引入文件符号链接依赖**：严禁在 `package.json` 中配置 `file:../packages/...`，npm 与 Bun 会将其解析为宿主机绝对路径软链，导致部署容器环境出现 `ENOENT` 挂起崩溃。

### Vite 配置前向兼容要求

Vite 8.3 起会对 `vite.config.ts` / `vitest.config.ts` 发出 `configLoader: 'native'` 告警，
原生配置加载器将成为未来主版本默认。配置文件中**必须**满足：

1. **不得使用 `__dirname` / `__filename`**（CJS 全局，原生加载器下不存在）→ 一律用
   `import.meta.dirname`（Node ≥20.11，本项目两端均满足；`@types/node` 已声明该类型）。
2. **相对 import 必须带扩展名**（如 `'./src/data/PageMeta.ts'`）→ `tsconfig.node.json`
   已开 `allowImportingTsExtensions`，带扩展名合法。
3. **不得使用不可擦除语法**（`enum`、`namespace`、参数属性等）→ `tsconfig.node.json`
   已开 `erasableSyntaxOnly`，违反即类型检查报错。

**注意**：测试文件（走 Vite SSR transform）不适用第 1 条 —— `import.meta.dirname` 在 SSR
transform 下不保证被改写，`src/lib/*.test.ts` 中继续使用 `__dirname` 是**有意为之**，勿「顺手统一」。

### 依赖版本约束（升级前必读）

以下三条是实测得出的硬约束，升级依赖时不得绕过：

| 包 | 锁定值 | 约束原因 |
|---|---|---|
| `typescript` | 两端均 5.9.x | TypeScript 最新为 7.x，但 `typescript-eslint`（含 `canary`）的 peer 上限是 `typescript: >=4.8.4 <6.1.0`，升到 7 会直接打挂 `npm run lint`。必须等 typescript-eslint 放开上限后再升。 |
| `@applemusic-like-lyrics/core` / `react` | 0.5.2 | `0.6.0` 上游把 `vitest ^4.1.10` 误写进 `dependencies`（0.5.2 是干净的，写在 `devDependencies`），且 registry 上没有修复版本。升级会让测试框架进入生产依赖树，而 `0.6.0` 的导出面与 `0.5.2` 逐符号比对完全一致、零功能收益。 |
| `jsdom` | 30.1.1 | engines 为 `^22.22.2 \|\| ^24.15.0 \|\| >=26.0.0`，卡得很紧。CI 的 `actions/setup-node@v4` 用 `node-version: 22` 取最新 22.x 恰好满足；若 CI 的 Node 降到 22.22.2 以下，`npm ci` 会失败。 |

补充事实：

- **`Server/package.json` 里的 `bun` 是可执行运行时 pin，改它会改变测量仪器。**
  `bun run <script>` 会把 `node_modules/.bin` 前置到 PATH，因此脚本内层调用的 `bun`
  解析到的是 **pin 的那个版本**（不是全局 bun）。实战后果：pin 从 1.3.14 升到 1.4.2 后，
  `test:coverage` 的测量口径随之改变，函数分母从 3589 掉到 1649，直接打挂 `CheckCoverage.ts`
  的棘轮阈值。**因此改 bun pin 必须与 `CheckCoverage.ts` 阈值重校同批进行**，现行阈值
  `90.66 / 94.31` 即为 1.4.2 口径标定值。
- **切换到新 bun 版本后的首次启动会付一次冷缓存成本**：实测 `src/Index.ts` 冷启动到
  `/health` 就绪 12.1s，热缓存仅 0.94s（1.3.x 冷启动 2.45s）。`ProductionSmoke.ts` 的探活
  超时是 15s 且 spawn 的 `stdout/stderr` 全为 `ignore`（崩溃时看不到任何日志），
  所以换 bun 后第一次跑冒烟可能假红——**先重跑一次再判断**。
- `bun install` 在**非 verbose** 模式下解析阶段可能病态停顿 10 分钟以上且零输出（连日志 mtime 都停住）；同一状态加 `--verbose` 后实测 1 秒内跑完。遇到卡死先换 `--verbose` 复现再判断，别误判成网络问题去折腾代理。
- 升级依赖前后的验证必须**先跑基线**（Server `check` + `test`，Client `lint` + `test:coverage` + `build`），否则无法区分「新引入的破坏」与「本来就坏」。
- 预检优于装完再测：把新旧 tarball 解到 `.workbuddy/tmp/` 直接比 `.d.mts` 导出面与 `dependencies` 字段，可在不触碰 `node_modules` 的前提下否掉一次升级（AMLL 0.6.0 即如此否掉）。注意过滤 `.d.ts` 会漏掉 `.d.mts`/`.d.cts`。

---

## 5. 开发、构建与验证命令 (Workspace Commands)

### 服务端 (`cd Server`)
```bash
bun run dev          # 启动热重载开发服务器 (默认端口 4850)
bun run start        # 启动生产服务器
bun run check        # 执行 tsc --noEmit 全量静态类型检查
bun test             # 运行全部 bun:test 单元测试与集成测试
bun test --coverage  # 运行单测并生成代码覆盖率报告
bun run docs:openapi # 重新生成并导出 Agents/http-openapi.json
```

### 客户端 (`cd Client`)
```bash
npm run dev          # 启动 Vite 开发服务器 (http://localhost:5173)
npm run build        # 执行 tsc -b && vite build 生产打包构建
npm run lint         # 执行 ESLint 严格静态代码检查
npm test             # 运行 Vitest 单元与集成测试
npm run test:watch   # 交互式监听单测
npm run test:coverage# 运行单测并输出覆盖率报告
npm run test:e2e     # 运行 Playwright 端到端测试 (自动起 Server + Vite)
npm run verify       # 运行完整质量门禁 (lint + coverage + build + E2E)
npm run preview      # 本地预览生产构建产物
```

---

## 6. 环境变量规范 (Environment Variables)

### 服务端 `Server/.env` (参考 `Server/.env.example`)
```bash
CLIENT_URL=http://localhost:5173
SERVER_URL=http://localhost:4850
SERVER_PORT=4850
BANGUMI_API_URL=https://api.bgm.tv
BANGUMI_IMAGE_URL=
```

`BANGUMI_API_URL` 是服务端访问 Bangumi API 的镜像入口，`BANGUMI_IMAGE_URL` 是番剧图片镜像入口。两者均只在服务端使用，客户端通过 WebSocket 获取已经重写的地址，不能直接请求 Bangumi 或使用 `lain.bgm.tv` 原始地址。

### 客户端 `Client/.env` (参考 `Client/.env.example`)
```bash
VITE_SERVER_URL=http://localhost:4850
```

`VITE_SERVER_URL` 是接口基址的唯一入口，取值语义见 `Client/src/lib/ServerEndpoint.ts`：

- `http://localhost:4850` —— 本地开发（Vite 5173 与 Bun 4850 分属不同源）。
- 留空（生产构建）或显式 `/`、`same-origin` —— 走同源相对路径。**该模式当前不可用**：
  同源反代 `Client/middleware.js` 因无法转发 WebSocket 请求已撤销，前端域名的 `/api/*`
  会被 SPA 兜底成 HTML。生产必须显式指向后端公开域名（跨域直连），详见
  `Agents/Deployment.md`「前后端同源化」。
