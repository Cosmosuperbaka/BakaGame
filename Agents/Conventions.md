# 工程规范与代码整洁度指南 (Conventions & Clean Code Guide)

本文档定义全栈代码库的命名一致性、目录结构、架构边界与重构准则，防止跨技术栈概念断层与风格割裂。

---

## 1. 命名规范 (Naming Conventions)

### 1.1 核心业务实体与专有名词常量命名

- **谁是卧底**: 全栈统一命名为 `WhoIsFaker`（缩写 `wif` 用于缓存/存储前缀如 `wif_session_`）。
- **猜歌游戏**: 全栈统一命名为 **`SonGuessr`（漏G版）**。
  - **TypeScript 类型/接口/类/变量**: 统一使用 `SonGuessr`（如 `SonGuessrService`, `SonGuessrRoomSnapshot`, `SonGuessrPrivateState`, `UseSonGuessrStore`, `SonGuessrProvider`）。为保障向后兼容，导出层可保留 `SongGuessr...` 别名。
  - **常量命名 (Constants)**：`SonGuessr` 为专有名词，常量一律使用 **`SONGUESSR_XXX`** 前缀（例如 `SONGUESSR_PHASES`, `SONGUESSR_MAX_PLAYERS`, `SONGUESSR_MUSIC_SESSION_CHANGED`），严禁拆分为 `SON_GUESSR_`。
  - **URL 路由 / API 路径 / 存储命名空间**: 统一使用 `songuessr`（如 `/songuessr`, `/api/songuessr/ws`, `songuessr_session_`, `songuessr_netease_session_v1`）。

### 1.2 文件与目录命名法则（全量大驼峰 PascalCase）

所有代码与测试文件统一使用**大驼峰命名法（PascalCase / UpperCamelCase）**：

| 文件类型 | 命名规则 | 示例 | 放置位置 |
|---|---|---|---|
| **TypeScript 核心模块** | `PascalCase.ts` | `RoomService.ts`, `SonGuessrService.ts`, `StateSync.ts`, `Rules.ts`, `Index.ts` | `Server/src/application/`, `Server/src/transport/`, `Client/src/lib/` |
| **基础设施与仓储** | `PascalCase.ts` | `NeteaseMusicProvider.ts`, `WordBankRepository.ts`, `EventLogger.ts` | `Server/src/infrastructure/` |
| **自定义 Hooks** | `PascalCase.ts` (`Use*.ts`) | `UseAutoSave.ts`, `UseAutoScrollToBottom.ts`, `UseOriginTracker.ts` | `Client/src/hooks/` |
| **状态 Store** | `PascalCase.ts` (`Use*.ts`) | `UseWhoIsFakerStore.ts`, `UseSonGuessrStore.ts` | `Client/src/stores/` |
| **React Context** | `PascalCase.tsx` | `WhoIsFakerContext.tsx`, `SonGuessrContext.tsx` | `Client/src/contexts/` |
| **React 页面与组件** | `PascalCase.tsx` | `Main.tsx`, `WhoIsFakerRoomPage.tsx`, `SonGuessrRoomPage.tsx`, `PhaseHeader.tsx`, `EmojiPicker.tsx`, `Button.tsx` | `Client/src/pages/`, `Client/src/components/` |
| **测试与集成文件** | `PascalCase.test.ts(x)` | `RoomService.test.ts`, `Rules.test.ts`, `UseWhoIsFakerStore.test.ts`, `UseAutoSave.test.tsx` | 与源文件同名放置在 `test/` 或源码同级 |

---

## 2. 目录架构与职责划分 (Directory Structure)

### 2.1 前端目录结构 (`Client/src/`)

```
Client/src/
├── components/
│   ├── common/              # 跨游戏复用组件（PhaseHeader.tsx, EmojiPicker.tsx, CreateRoomDialog.tsx 等）
│   ├── whoisfaker/
│   │   ├── phases/          # 谁是卧底各阶段内容（WaitingPhase.tsx, DescriptionPhase.tsx, VotingPhase.tsx 等）
│   │   └── layout/          # 房间布局与专属组件（GameArea.tsx, PlayerList.tsx, ChatPanel.tsx, TestController.tsx 等）
│   ├── songguessr/          # 猜歌游戏专属组件（SongPlayerList.tsx, SongChatPanel.tsx, SongSearchDialog.tsx 等）
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
│   ├── RoomService.ts       # 谁是卧底核心业务服务
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
