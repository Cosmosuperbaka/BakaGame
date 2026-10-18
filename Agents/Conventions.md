# 工作区与命名约定

涉及命名或文件位置时读 §1—§3；启动与依赖升级读 §4—§5；配置读 §6。架构不变量见 [Spec](Spec.md)，验证范围及测试命令见 [Testing](Testing.md)。

---

## 1. 命名规范 (Naming Conventions)

### 1.1 核心业务实体与专有名词常量命名

- **谁是卧底**: 全栈统一命名为 `WhoIsFaker`。会话凭据存储前缀用全称口径 **`whoisfaker_session_`**，不使用旧缩写 `wif_`；旧键搬迁由 `Client/src/lib/Storage.ts` 的 `migrateLegacyKeys` 承担。
- **猜歌游戏**: 全栈统一命名为 **`SonGuessr`（漏G版）**。
  - **TypeScript 类型/接口/类/变量**: 统一使用 `SonGuessr`（如 `SonGuessrService`, `SonGuessrRoomSnapshot`, `SonGuessrPrivateState`, `UseSonGuessrStore`, `SonGuessrProvider`）。命名以本节为准；删除旧别名的约束见 [Spec §4](Spec.md)。
  - **常量命名 (Constants)**：`SonGuessr` 为专有名词，常量一律使用 **`SONGUESSR_XXX`** 前缀（例如 `SONGUESSR_PHASES`, `SONGUESSR_MUSIC_SESSION_CHANGED`），严禁拆分为 `SON_GUESSR_`。
  - **URL 路由 / API 路径 / 存储命名空间**: 统一使用 `songuessr`（如 `/songuessr`, `/api/songuessr/ws`, `songuessr_session_`, `songuessr_netease_session_v1`）。
- **二刺猿笑传之猜猜呗增强版**: 全栈统一命名为 **`CEE`**（三个字母全大写，副标题「二刺猿笑传之猜猜呗」只作为页面对外展示文案，不进标识符）。
  - **TypeScript 类型/接口/类/变量**: 一律使用 **`CEE`** 缩写（`CEEService`、`CEERoomSnapshot`、`CEEPrivateState`、`CEEPlayerRecord`、`parseCEEMessage`、`UseCEEStore`）。**严禁**写成 `CeeService`、`CeeRoom` 之类的混合大小写拼法；`ceeService` 这类以小写开头的局部变量与实例名按常规驼峰处理。
  - **常量命名 (Constants)**：一律使用 **`CEE_XXX`** 前缀（如 `CEE_PHASES`, `CEE_STATE_EVENTS`, `CEE_PLAYER_MESSAGE_LIMIT`）。
  - **URL 路由 / API 路径 / 存储命名空间**: 统一使用 `cee`（如 `/cee`、`/api/cee/ws`、`cee_session_`），ID 前缀同例（`cee_player_`、`cee_chat_`）。
  - **不改的例外**: 环境变量 `CCB_ORIGINAL_SERVER_URL` / `CCB_ORIGINAL_AES_SECRET` 是部署侧的既有契约，外部仓库 `CCB-TagsCI`
    与外部站点 `ccb.baka.website` 也不属于本项目的命名；这三类保持原样，不要跟着改名。

### 1.2 代码文件命名

TypeScript 业务代码与测试文件使用 **PascalCase**，目录沿用现有小写结构；框架配置、资源、Python 与构建脚本保留各自现有约定，不批量改名：

| 文件类型 | 命名规则 | 示例 | 放置位置 |
|---|---|---|---|
| **TypeScript 核心模块** | `PascalCase.ts` | `WhoIsFakerService.ts`, `SonGuessrService.ts`, `StateSync.ts`, `Rules.ts`, `Index.ts` | `Server/src/application/`, `Server/src/transport/`, `Client/src/lib/` |
| **基础设施与仓储** | `PascalCase.ts` | `NeteaseMusicProvider.ts`, `WordBankRepository.ts`, `EventLogger.ts` | `Server/src/infrastructure/` |
| **自定义 Hooks** | `PascalCase.ts` (`Use*.ts`) | `UseAutoSave.ts`, `UseAutoScrollToBottom.ts`, `UseOriginTracker.ts` | `Client/src/hooks/` |
| **状态 Store** | `PascalCase.ts` (`Use*.ts`) | `UseWhoIsFakerStore.ts`, `UseSonGuessrStore.ts` | `Client/src/stores/` |
| **React Context** | `PascalCase.tsx` | `WhoIsFakerContext.tsx`, `SonGuessrContext.tsx` | `Client/src/contexts/` |
| **React 页面与组件** | `PascalCase.tsx` | `Main.tsx`, `WhoIsFakerRoomPage.tsx`, `SonGuessrRoomPage.tsx`, `PhaseHeader.tsx`, `EmojiPicker.tsx`, `Button.tsx` | `Client/src/pages/`, `Client/src/components/` |
| **测试与集成文件** | `PascalCase.test.ts(x)` | `WhoIsFakerService.test.ts`, `Rules.test.ts`, `UseWhoIsFakerStore.test.ts`, `UseAutoSave.test.tsx` | 与源文件同名放置在 `test/` 或源码同级 |
| **Storybook 故事** | `PascalCase.stories.tsx` | `Button.stories.tsx`, `PlayerList.stories.tsx` | 与组件同级；假数据放 `Client/src/stories/fixtures/`，预览配置在 `Client/.storybook/` |

---

## 2. 目录职责

| 位置 | 职责 |
|---|---|
| `Server/src/shared/` | 平台及各游戏共享契约，`Index.ts` 汇总导出 |
| `Server/src/domain/` | 纯业务规则、领域类型与错误 |
| `Server/src/application/` | 服务编排、命令处理与连接登记 |
| `Server/src/infrastructure/` | 外部 Provider、Worker、数据仓储与日志 |
| `Server/src/transport/` | HTTP/WS 路由、边界解析及状态同步 |
| `Client/src/components/ui/`、`common/` | 基础控件与跨游戏组件 |
| `Client/src/components/{whoisfaker,songuessr,cee}/` | 各游戏视图，不横向导入其他游戏目录 |
| `Client/src/pages/`、`contexts/`、`stores/` | 页面入口、连接生命周期、状态管理 |
| `Client/src/hooks/`、`lib/`、`config/` | 复用 Hook、通信与工具、静态配置 |
| `Client/src/types/Index.ts` | 共享类型的客户端导出入口 |
| `Client/.storybook/`、`Client/src/stories/` | 组件截图工具的预览配置、假数据与 Store 预置，只供开发，不被应用代码导入 |

本表说明职责，不维护逐文件目录树；查找实现时搜索目标符号或路径。

## 3. 跨端状态边界

共享契约的物理位置和映射见 §4，平台/游戏依赖方向见 [Spec §11](Spec.md)。

- Store 的 `setSnapshot` 接收服务端权威状态；动画、淘汰展示与本地聊天提示属于独立展示派生层，不修改或延迟协议基线（Spec §8.3、§9.3）。
- 组件不推断私有权限、不覆盖服务端快照。表单弹窗通过 Props 与校验回调采集数据，不隐式绑定具体游戏 Store。
- 跨游戏能力放 `components/common/` 或 `hooks/`，复用边界见 Spec §11。
- 滑动窗口数组（`room.chat`）的下行编码依赖「挤出最旧、追加最新」这一形状：服务端只发 `remove /chat/0` 与 `add /chat/N`，客户端 `applyPatch(..., true)` 复现同一结果。改成定长原地覆盖、换序或环形队列必须两端同步改，否则补丁静默错位。

## 4. 工作区架构与运行环境 (Workspace Structure & Runtime)

本项目是一个**根级 pnpm workspace**：根目录有 `package.json` 与 `pnpm-workspace.yaml`，`Client/` 与 `Server/` 是两个成员包。**pnpm 只做依赖安装与任务编排，不替换任一端的运行时**：

| 包名 | 目录 | 运行时 / 包管理器 | 源码目录 | 默认端口 |
|---|---|---|---|---|
| `server` | `Server/` | **Bun**（`bun run`、`bun:test`、`Bun.env`、`Bun.sleep`、`Bun.spawn`） | `Server/` | `4850` |
| `client` | `Client/` | **Node / Vite**（React 19、Vitest、Playwright） | `Client/` | `5173` |

### 脚本边界（必须维持）

- **Server 一律由 Bun 执行**：`Server/package.json` 的每个脚本都以 `bun` 开头，`pnpm --filter server <script>` 只是把这条命令转发出去；根级脚本不得把 Server 的目标换成 node/tsx。
- **Client 一律由 Node 执行**：Vite/Vitest/Playwright 及 `Client/scripts/*.mjs` 都走 Node，根级脚本不得改用 Bun 跑。
- 根目录的 `dev` / `build` / `check` / `test` / `lint` / `coverage` / `e2e` / `verify` 是**编排壳**，内部一律 `pnpm --filter <client|server> <script>`，逐个转发到上面两条链，不合并签名、不代跑。例外：`lint` 用 `pnpm -r lint` 递归两端（两端规则面一致，见 [Testing](Testing.md#lint-基线与复杂度门禁)），`lint:prune` 同源。

### 依赖安装与锁文件权威关系

- **唯一权威锁文件 = 根级 `pnpm-lock.yaml`**，由 `pnpm install --frozen-lockfile` 消费（CI 与本机一致）。
- **不得保留 `package-lock.json` 与 `bun.lock`**：两者都会在 CI 里制造「装的是哪份锁」的歧义，且 workspace 下 npm/bun 已不再负责安装。`.gitignore` 一并忽略两者。
- 根级 `.npmrc` 的两条设置是运行前提，改动前先读文件内注释：`node-linker=hoisted`（避免软链破坏 Server 的容器 bind-mount 与单文件打包）与 `enable-pre-post-scripts=true`（放行 `bun`/`esbuild` 的 postinstall，否则 Server 的 `bun <script>` 会命中上游预置的「postinstall 未运行」占位脚本）。
- 依赖版本约束（如 `typescript` 的两条线——API 面 6.0.x、编译器 7.0.x、AMLL 0.5.2、`jsdom` 30 的 Node 下限、`@neteasecloudmusicapienhanced/api` ≥ 4.41.0）仍然是升级门禁，见下方「依赖版本约束」。

### 依赖路径不得写死 `Server/node_modules`

workspace 会把依赖提升到**仓库根** `node_modules/`，Server 下通常**不存在** `Server/node_modules`。因此运行期读取依赖包内附带数据文件时，**必须走 Node 模块解析**（`createRequire(import.meta.url).resolve("<pkg>/package.json")` 再取同级文件），不得写死 `../../node_modules/...` —— 写死路径会静默拿到空内容并退化成兜底行为（`NeteaseMusicProvider` 的 CN IP 段即此坑）。独立安装（无 workspace）时同一写法仍命中 `Server/node_modules`。

### 共享协议与契约映射机制 (`@bakagame/shared`)
- **单一真相源位置**：全库的共享定义统一位于 `Server/src/shared/`（平台 `Model.ts`、`Protocol.ts` 与各游戏契约），两端共用同一份代码实体。
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

以下为依赖约束；版本来源是各包清单与锁文件。只有针对原因完成验证后才更新约束，不把上游某一时的状态当作永久事实：

| 包 | 锁定值 | 约束原因 |
|---|---|---|
| `typescript`（API 线） | 两端均 `npm:@typescript/typescript6@6.0.2`（落位 6.0.3） | 只给**消费 TS 程序化 API** 的工具用：`typescript-eslint`、`ts-api-utils`、`eslint-plugin-sonarjs` 与 `tsc6`。`typescript-eslint`（含 `canary`）peer 上限为 `typescript: >=4.8.4 <6.1.0`，所以这条线停在 6.0.x；生效前提是根 `pnpm-workspace.yaml` 的 override，见下方补充约束。 |
| `typescript7`（编译器线） | 两端均 `npm:typescript@7.0.2`，bin 只有 `tsc` | 原生 Go 编译器，跑 `check` / `build` / `tsc -b`；**没有稳定程序化 API**（7.1 才提供），因此不得被 lint 工具链当作 `typescript` 解析目标。别名键 `typescript7` 不受 override 影响，两条线互不代跑。 |
| `@applemusic-like-lyrics/core` / `react` | 0.5.2 | `0.6.0` 上游把 `vitest ^4.1.10` 误写进 `dependencies`（0.5.2 是干净的，写在 `devDependencies`），且 registry 上没有修复版本。升级会让测试框架进入生产依赖树，而 `0.6.0` 的导出面与 `0.5.2` 逐符号比对完全一致、零功能收益。 |
| `jsdom` | 30.1.1 | engines 为 `^22.22.2 \|\| ^24.15.0 \|\| >=26.0.0`，卡得很紧。CI 的 `actions/setup-node@v4` 用 `node-version: 22` 取最新 22.x 恰好满足；`pnpm install` 在 engines 不满足时硬失败，因此 CI 的 Node 不得降到 22.22.2 以下（根 `package.json` 的 `engines.node` 同口径声明）。 |
| `storybook` / `@storybook/react-vite` | 10.6.0（精确锁定，两包同版本） | 只作开发依赖，不进生产包。已核对 peer：`vite ^5–^8`、`react ^16.8–^19`、`typescript >=4.9`。它合并 `vite.config.ts`，`.storybook/main.ts` 剔除了会改写 `dist/` 的 `static-shell` 插件；升级 Vite 大版本或 Storybook 时先确认 peer 覆盖，再跑 `build-storybook` 与 `storybook:shots`。 |
| `@neteasecloudmusicapienhanced/api` | ≥ 4.41.0 | 设备名上报依赖该包的原生 `deviceinfo_center_upload` 模块，`4.40.x` 及更早没有它。低于此版本只能退回「直接导入包内 `util/request`/`util/option` 自拼 EAPI」，违反 [NeteaseMusicApi](NeteaseMusicApi.md) 的「只用公开接口」规则，因此下限不可回退。 |
| `eslint-plugin-sonarjs` | 两端均 `4.2.2` | 提供 `sonarjs/cognitive-complexity`（阈值 20）。`4.2.2` 的 peer 为 `eslint: ^8 \|\| ^9 \|\| ^10`，是当前能覆盖 ESLint 10.11 的版本；它同时被 Ultracite 8 使用，规则实现与阈值口径一致。升级须先确认 peer 覆盖到项目 ESLint 版本，并重跑两端 `pnpm lint`（基线见 [Testing](Testing.md#lint-基线与复杂度门禁)）。 |
| `eslint-plugin-check-file` | 两端均 `3.3.2` | 文件名 PascalCase 门禁。`ignoreMiddleExtensions` 必须开：`X.test.tsx` / `X.stories.tsx` 的中缀段本身不是 PascalCase，关掉会把全仓测试与故事判违规。 |
| `prettier` | `3.9.10`（根 devDependency） | 唯一格式化器，配置在根 `prettier.config.mjs`。`endOfLine: "auto"` 是有意设置：工作区 CRLF、CI 检出 LF，auto 保留各文件原样；改成 `lf` / `crlf` 会让另一端起整文件级 diff。CI 用 `pnpm format:check` 校验。 |

补充约束：

- **两条 TypeScript 线只靠根 `pnpm-workspace.yaml` 的 `overrides: typescript: npm:@typescript/typescript6` 兜住。** `eslint-plugin-sonarjs@4.2.2` 把 `typescript` 声明成硬依赖（`>=5 <6.1.0`），`ts-api-utils` 再按它的 peer 变体提升；没有 override 时 pnpm 会给这两处各自嵌套装一份真 `typescript@5.9.3`，类型感知规则于是拿 5.9 的 `TypeFlags` 常量去读 6.0 创建的 `Program`，`no-misused-promises` 直接崩在 `tsutils.unionConstituents`（Client `pnpm lint` 报 `is not a function or its return value is not iterable`）。装完先看根 `node_modules/typescript` 是否唯一（`require("typescript").version` 与 `tsc6 --version` 都应是 6.0.x），再跑两端 lint。override 的值必须写成**不带版本的别名**：加上 `@6.0.2` 后 pnpm 会拿依赖方要求的 `5.9.3` 去套这个别名，报 `No matching version found`。
- **编辑器语言服务不得指向 `typescript7`。** 7.0.x 没有程序化 API，把 `typescript.tsdk` 指过去会让 TS 语言服务失效；编辑器红线与门禁结论不一致时以 `pnpm check`（`tsc` 7）和 `pnpm lint`（API 6）为准。

- **根级 `knip` 只做静态分析，不参与构建与运行时。** 配置在根 `knip.jsonc`：workspace 入口（测试、故事、E2E、`bun --preload` 夹具）、导出/类型的分级规则都在那里维护。`knip --fix` 会按报告直接删除代码与导出，**禁止在本地或 CI 启用**。Knip 会加载 `Client/vite.config.ts` 读取别名等配置，但**加载配置本身不写盘**：`.generated-public` 的重建在 `public-webp` 插件的 `config` 钩子里，只有创建 dev server 或构建时才执行，因此不再需要删除豁免开关。
- **`Server/package.json` 里的 `bun` 是可执行运行时 pin，改它会改变测量仪器。**
  `bun run <script>` 会把 `node_modules/.bin` 前置到 PATH，因此脚本内层调用的 `bun`
  解析到的是 **pin 的那个版本**（不是全局 bun）。改 pin 会改变 `test:coverage` 的插桩口径
  （函数分母随之变化），直接打挂 `CheckCoverage.ts` 的棘轮阈值。
  **因此改 bun pin 必须与 `CheckCoverage.ts` 阈值重校同批进行**。阈值直接读取该脚本；四舍五入后的显示值不是门禁值，不能直接设为阈值。
- **切换 bun 版本后的首次启动会付一次冷缓存成本**，冷启动到 `/health` 就绪可能明显超过
  热缓存耗时而触发 `ProductionSmoke.ts` 的探活超时（该脚本把 spawn 的 `stdout/stderr` 置为
  `ignore`，崩溃时看不到日志），所以换 bun 后第一次跑冒烟可能假红——**先重跑一次再判断**。
- `bun install` 在**非 verbose** 模式下解析阶段可能病态停顿且零输出（连日志 mtime 都停住）；
  同一状态加 `--verbose` 即可跑完。遇到卡死先换 `--verbose` 复现再判断，别误判成网络问题去折腾代理。本仓库日常安装走根级 `pnpm install`，此条只在独立调试 `bun install` 时适用。
- 升级前在受影响包运行基线，升级后用同一组检查比较；共享工具链或跨端契约升级覆盖两端。具体范围见 [Testing](Testing.md#验证范围)。
- 预检优于装完再测：把新旧 tarball 解到临时目录直接比 `.d.mts` 导出面与 `dependencies` 字段，可在不触碰 `node_modules` 的前提下否掉一次升级。注意过滤 `.d.ts` 会漏掉 `.d.mts`/`.d.cts`。

---

## 5. 开发与构建命令

命令定义以根级 [package.json](../package.json)、[Server/package.json](../Server/package.json) 和 [Client/package.json](../Client/package.json) 为准。

**推荐在仓库根用 workspace 编排**（内部即转发到各包脚本）：

| 目的 | 根级命令 | 等价单包命令 |
|---|---|---|
| 装依赖 | `pnpm install` | ——（根级唯一入口） |
| 起全部开发服务 | `pnpm dev` | `pnpm --filter server dev` + `pnpm --filter client dev` |
| 仅起一端 | `pnpm dev:server` / `pnpm dev:client` | `bun run dev` / `npm run dev` |
| 类型检查 | `pnpm check` | `pnpm --filter server check` / `pnpm --filter client check` |
| 构建 | `pnpm build`（先 server check 再 client build） | `pnpm --filter client build` |
| 测试 | `pnpm test` | `pnpm --filter server test` / `pnpm --filter client test` |
| 覆盖率 | `pnpm coverage` | 各包 `test:coverage` |
| Lint | `pnpm lint` | `pnpm --filter client lint` / `pnpm --filter server lint` |
| 格式化 | `pnpm format`（写入） | `pnpm format:check`（只校验，CI 用） |

**也可以直接进入单包目录执行**（与根级转发等价）：

| 包 | 开发 | 生产运行或预览 | 类型与构建 |
|---|---|---|---|
| `Server/` | `bun run dev` | `bun run start` | `bun run check`、`bun run lint` |
| `Client/` | `npm run dev` | `npm run preview` | `npm run build`、`npm run lint` |
| `Client/` 组件工作台 | `npm run storybook` | `npm run build-storybook` | `npm run storybook:shots`（用法见 [Testing](Testing.md#组件截图storybook)） |

HTTP 契约变更需要导出时，在 Server 执行 `bun run docs:openapi`，产物为 `Agents/http-openapi.json`。产物同时包含 Elysia 声明的 HTTP 路由与 oRPC 账号契约（由 `shared/ApiContract.ts` 的 `meta` 生成），改了契约不重跑会被 `Server/test/RpcOpenapi.test.ts` 的在库比对断言拦下。导出固定用 `DOC_SERVER_URL` 本地占位，不读 `SERVER_URL`：部署主机名（可能是内网名）不该进仓库。测试、覆盖率、资源冒烟与完整门禁命令统一见 [Testing](Testing.md)。

## 6. 环境变量规范 (Environment Variables)

### 服务端 `Server/.env` (参考 `Server/.env.example`)
```bash
CLIENT_URL=http://localhost:5173
SERVER_URL=http://localhost:4850
SERVER_PORT=4850
BANGUMI_API_URL=https://api.bgm.tv
BANGUMI_IMAGE_SOURCE=
MEILISEARCH_KEY=
CCB_ORIGINAL_AES_SECRET=
DATABASE_URL=
BETTER_AUTH_SECRET=
SMTP_HOST=
SMTP_PORT=465
SMTP_USER=
SMTP_PASS=
MAIL_FROM=
MAIL_DEV_CONSOLE=
ADMIN_QQ=
```

`BANGUMI_API_URL` 是服务端访问 Bangumi API 的镜像入口。两者均只在服务端使用，客户端通过 WebSocket 获取已经重写的地址，不直接请求 Bangumi API。**番剧图片的对外前缀写死 `/api/bangumi`（自建图床），不提供环境变量开关** —— 前缀可配就必然有人配出边缘不放行的路径，线上整站图片会变成 SPA HTML。图片在服务端按固定前缀重写，不再把 Bangumi 源站（国内多数网络连不上）透给浏览器；`BANGUMI_IMAGE_SOURCE` 只决定图床缺图时去哪补（留空 = 只服务已缓存的图），细节见 [BangumiApi](BangumiApi.md#配置)，生产要求见 [Deployment](Deployment.md)。

`MEILISEARCH_KEY` 供 CEE 与 SonGuessr 共用的内部搜索，生产环境必填；Meilisearch 的 master key 必须设为相同值，
并与本服务共享 `127.0.0.1:7700` 网络空间（独立容器不能直接使用各自的 `localhost`）。搜索连接地址
和 5 秒请求超时由代码固定，不向客户端暴露。启动会校验 Meilisearch 健康状态并维护搜索索引；
未设置搜索密钥仅供本地开发和隔离测试使用本地搜索。`CCB_ORIGINAL_AES_SECRET` 仅供原版兼容房使用。

`DATABASE_URL` 是 TiDB（MySQL 协议）连接串，必须带库名，生产必填；未配置时账号、云同步、后台与对局记录关闭。连接、迁移与导入见 [Database](Database.md)。账号系统随数据库启用，`BETTER_AUTH_SECRET`、SMTP、`MAIL_DEV_CONSOLE` 与 `ADMIN_QQ` 的规则见 [Account](Account.md#9-配置)。

### 客户端 `Client/.env` (参考 `Client/.env.example`)
```bash
VITE_SERVER_URL=http://localhost:4850
```

`VITE_SERVER_URL` 是接口基址的唯一入口，取值语义见 `Client/src/lib/ServerEndpoint.ts`：

- `http://localhost:4850` —— 本地开发（Vite 5173 与 Bun 4850 分属不同源）。
- 留空（生产构建）或显式 `/`、`same-origin` —— 走同源相对路径。**生产不得使用该模式**：
  同源反代无法转发 WebSocket，前端域名的 `/api/*` 会被 SPA 兜底成 HTML。生产必须显式指向后端公开域名（跨域直连），详见
  [Deployment](Deployment.md#请求链路与同源化边界)。

共享源码的运行依赖由消费端显式声明；两端都必须声明 TypeBox。客户端 TypeScript paths 与 Vite/Vitest dedupe 将共享文件的 TypeBox 导入解析到 Client 安装，Storybook 复用 Vite 配置，不依赖 Server/node_modules，也不复制 schema。

### 运行环境标记与资产验证隔离

- 服务端遥测环境仅由 `readEnv` 统一解析：`DEPLOYMENT_ENVIRONMENT` → `OTEL_DEPLOYMENT_ENVIRONMENT` → `OTEL_RESOURCE_ATTRIBUTES` 的 `deployment.environment` → `NODE_ENV` → `development`。生产必须显式注入 `production`，测试使用 `test`；未配置不假设生产，不按操作系统猜测环境，Sentry 与 OTLP 消费同一结果，SDK 不再另读 `NODE_ENV`。
- 服务端 canonical release 为 `Vx.y.z（hash）`，hash 固定取完整 SHA 的前 7 位。源码仓库 Git/changelog 优先，无 Git 的容器使用部署生成且已忽略的 `Server/build/release.json`（稳定版本与完整 40 位 SHA）。没有有效发布证据时解析结果为 `undefined`，不硬编码版本、不采信任意 `SENTRY_RELEASE`/CI 字符串；SDK 初始化以显式空值关闭自动 release 探测并提示缺失。元数据生成、原子落盘与验收见 [Deployment](Deployment.md#发布元数据与遥测验收)。
- 公共图片统一转换为 WebP；表情的 `/emojis/` 公共路径与 `/stickers/` 内容哈希路径保留，单次有界编码后复制同一产物，不重复编码动画。
- Vite 与 Storybook 的构建配置会重建 `.generated-public`，同一工作区必须串行构建。资源冒烟只服务已有 `dist`，使用不加载项目配置、环境文件及后端代理的独立 preview，绑定回环随机端口；隔离副本的构建不共享主工作区生成目录。

### 入站参数与规范化状态

Song 自动筛选的局部输入与完整房间状态分别使用共享 `SongAutoFiltersInputSchema` / `SongAutoFiltersSchema`，类型由 Schema 的 `Static` 导出；服务端边界后补齐省略字段，客户端不得把局部输入当成完整快照。CEE 线路可空信封字段在解析边界归一为字段缺席，业务信封只使用可选字符串。双方 TypeScript 及协议边界回归必须同时通过。
