# 工作区与命名约定

涉及命名或文件位置时读 §1—§3；启动与依赖升级读 §4；配置读 §5。架构原则见 [Spec](Spec.md)，验证范围见 [Testing](Testing.md)。命令、脚本名、端口、版本号、变量清单读各 `package.json`、`.env.example` 与代码，本文只记约定与理由。

## 1. 命名规范

### 1.1 业务实体与专有名词

- **谁是卧底**：全栈统一 `WhoIsFaker`（常量 `WHOISFAKER_XXX`，路由/存储命名空间 `whoisfaker`）。会话凭据存储前缀用全称口径，不用旧缩写。
- **猜歌游戏**：全栈统一 **`SonGuessr`（漏 G 版）**，类型/变量用 `SonGuessr`，常量用 `SONGUESSR_XXX`（严禁拆成 `SON_GUESSR_`），URL/API/存储命名空间用 `songuessr`。严禁 `SongGuessr*` 与 `SonGuessr*` 并存。
- **二刺猿笑传之猜猜呗增强版**：全栈统一 **`CEE`**（三字母全大写）。副标题只作页面展示文案，不进标识符。类型/变量写 `CEEService` 这类形式，**严禁** `CeeService` 混合大小写；以小写开头的局部变量按常规驼峰；常量 `CEE_XXX`；URL/API/存储命名空间 `cee`，ID 前缀同例。
- **不改的例外**：部署侧既有环境变量契约与外部仓库/站点的命名不属于本项目命名，保持原样，不要跟着改名。

### 1.2 代码文件命名

TypeScript 业务代码与测试文件使用 **PascalCase**，目录沿用现有小写结构；框架配置、资源、Python 与构建脚本保留各自现有约定，不批量改名。

| 文件类型 | 规则 |
|---|---|
| TypeScript 核心/基础设施模块 | `PascalCase.ts` |
| 自定义 Hook、状态 Store | `Use*.ts`（PascalCase） |
| React 页面、组件、Context | `PascalCase.tsx` |
| 测试 | `PascalCase.test.ts(x)`，与源文件同名，放 `test/` 或源码同级 |
| Storybook 故事 | `PascalCase.stories.tsx`，与组件同级；假数据放故事夹具目录 |

文件名由 lint 规则强制（必须开启忽略中缀段，否则测试与故事文件会被判违规）。

## 2. 目录职责

| 位置 | 职责 |
|---|---|
| `Server/src/shared/` | 平台及各游戏共享契约，入口汇总导出 |
| `Server/src/domain/` | 纯业务规则、领域类型与错误 |
| `Server/src/application/` | 服务编排、命令处理与连接登记 |
| `Server/src/infrastructure/` | 外部 Provider、Worker、数据仓储与日志 |
| `Server/src/transport/` | HTTP/WS 路由、边界解析及状态同步 |
| `Client/src/components/ui/`、`common/` | 基础控件与跨游戏组件 |
| `Client/src/components/{whoisfaker,songuessr,cee}/` | 各游戏视图，不横向导入其他游戏目录 |
| `Client/src/pages/`、`contexts/`、`stores/` | 页面入口、连接生命周期、状态管理 |
| `Client/src/hooks/`、`lib/`、`config/` | 复用 Hook、通信与工具、静态配置 |
| `Server/docs/`、`Client/docs/` | 各包的领域规范；包内 `AGENTS.md` 做路由 |
| `.agent-notes/` | 不追踪的本地笔记（踩坑、生产相关），见根 `AGENTS.md` |

本表说明职责，不维护逐文件目录树；查找实现时搜索目标符号或路径。

## 3. 跨端状态边界

- Store 接收服务端权威状态；动画、淘汰展示与本地聊天提示属于独立展示派生层，不修改或延迟协议基线（见 [Client/docs/Engineering](../Client/docs/Engineering.md)）。
- 组件不推断私有权限、不覆盖服务端快照；跨游戏能力放 `components/common/` 或 `hooks/`。
- 共享协议的数组更新形状（如聊天滑动窗口）是两端的隐式契约：改成定长覆盖、换序或环形队列必须两端同步改。

## 4. 工作区与运行环境

本项目是**根级 pnpm workspace**，`Client/` 与 `Server/` 是两个成员包。**pnpm 只做依赖安装与任务编排，不替换任一端的运行时**。

- **Server 一律由 Bun 执行**，`pnpm --filter server <script>` 只是转发；根级脚本不得把 Server 的目标换成 node/tsx。
- **Client 一律由 Node 执行**（Vite/Vitest/Playwright 及客户端脚本），根级脚本不得改用 Bun。
- 根级编排脚本只做 `pnpm --filter <包> <脚本>` 的转发壳，不合并签名、不代跑；递归 lint 例外，见 Testing。

### 依赖安装与锁文件

- **唯一权威锁文件是根级 `pnpm-lock.yaml`**，安装入口只有根目录 `pnpm install`（CI 用冻结锁文件）。不得保留 `package-lock.json` 与 `bun.lock`（会在 CI 制造“装的是哪份锁”的歧义）。
- 根级 `.npmrc` 的设置是运行前提（提升式布局保证容器 bind-mount 与单文件打包；放行指定包的 postinstall），改动前先读文件内注释。
- **依赖被提升到仓库根 `node_modules/`，Server 下通常不存在 `Server/node_modules`**：运行期读取依赖包内附带数据文件必须走 Node 模块解析，**不得写死 `../../node_modules/...`**（写死路径会静默拿到空内容并退化成兜底行为）。

### 共享协议与契约映射（`@bakagame/shared`）

- 共享定义只有一份物理源码：`Server/src/shared/`。服务端通过相对路径引入；部署时只挂载 `Server/` 作为应用根，因此被引用的模块必须物理位于该目录内。
- 客户端用 `@bakagame/shared`，必须在两处保持同步映射：TypeScript `paths`（类型检查）与 Vite `resolve.alias`（打包）。Vite 不读 tsconfig paths，只改一处会让构建隐蔽失败。
- **严禁用 `file:../packages/...` 之类文件符号链接依赖**（会解析成宿主机绝对路径软链，导致容器 `ENOENT`）。
- 共享源码的运行依赖由消费端显式声明，两端都声明 TypeBox，不依赖对方的依赖目录，也不复制 schema。

### 工具链约束

- **两条 TypeScript 线**：lint 工具链消费 TS 的程序化 API，编译与类型检查用原生编译器（没有稳定程序化 API）。两条线靠根 `pnpm-workspace.yaml` 的 override 隔离；override 值必须写成**不带版本的别名**。装完先确认根 `node_modules/typescript` 唯一且落在程序化 API 那条线（具体版本与别名键读该文件与包清单）；动 `typescript` 依赖或 override 后两端都要重跑 lint 与 check，不看一端绿就收工。编辑器语言服务不要指向编译器那条线。
- 依赖版本约束以各包清单和锁文件为准；只有针对原因完成验证后才更新约束，不把上游某一时刻的状态当永久事实。升级前的已知门禁：
  - 歌词库：新版本若把测试框架误写进生产依赖则不升级，先核对其依赖字段与导出面；
  - `jsdom` 的 engines 范围很窄，CI 的 Node 版本不得低于其下限；
  - Storybook 只作开发依赖，升级 Vite 大版本或 Storybook 时先确认 peer 覆盖；
  - 网易云 API 包版本下限不可回退（低于下限只能自拼 EAPI，违反 [NeteaseMusicApi](../Server/docs/NeteaseMusicApi.md) 的“只用公开接口”规则）；
  - lint 插件升级先确认 peer 覆盖到项目 ESLint 版本；
  - Prettier 的 `endOfLine: "auto"` 是有意设置（工作区 CRLF、CI 检出 LF），改成固定值会让另一端起整文件 diff。
- Vite 配置前向兼容：配置文件**不得使用 `__dirname/__filename`**（用 `import.meta.dirname`）、**相对 import 必须带扩展名**、**不得使用不可擦除语法**（enum/namespace/参数属性）。测试文件走 SSR transform，不适用第一条，勿“顺手统一”。
- `knip` 只做静态分析；`knip --fix` 会直接删代码，**禁止在本地或 CI 启用**。入口在配置里显式声明，不用忽略清单掩盖真实问题。
- **Server 的 `bun` 是可执行运行时 pin，改它会改变测量仪器**（覆盖率插桩口径）。改 pin 必须与覆盖率阈值重校同批进行，阈值读脚本而不是显示值。换 bun 后第一次冒烟可能因冷缓存假红，先重跑一次再判断。独立调试 `bun install` 若卡死先换 verbose 复现，别误判成网络问题。
- 升级前后在受影响包运行同一组检查；预检优于装完再测（比较新旧 tarball 的导出面与依赖字段，注意不要漏掉 `.d.mts/.d.cts`）。

### 开发与构建命令

命令定义以根与各包的 `package.json` 为准，推荐在仓库根用 workspace 编排。HTTP 契约变更需要导出时，用 Server 的 OpenAPI 导出脚本，产物位置见该脚本；产物包含 HTTP 路由与 oRPC 账号契约，与代码不同步会被对应测试拦下。导出固定使用本地占位基址，不读部署地址（部署主机名不该进仓库）。

## 5. 环境变量

- 变量名、默认值与取值规则以 `Server/src/config/env/Registry.ts`（`Server/.env.example` 由它生成）、`Client/.env.example` 和 `Server/src/config/env/` 的解析代码为准，文档不维护变量清单。
- 每个变量在注册表里必须表态属于哪一层：`T0` 进程拓扑与 `T1` 引导凭据只能是环境变量（建数据库连接之前就得有值），`T2` 部署期可调项缺省即正确、只在配置新实例需要知道时才进 `.env.example`，`DEV` 与已废弃项不进。代码读到没登记的名字、或 `.env.example` 与生成结果不一致时 `EnvRegistry` 测试直接报红。
- **`T3` 运行期旋钮**的生效值存数据库 `app_setting`，环境变量同名项退为缺省，管理员在后台「运行期旋钮」改，不需要重建容器。入选只有一条判据：改它的时候正好在停机窗口外，且改了只影响后续行为。凭据、监听地址、来源名单永远不进；键与校验规则见 `Server/src/shared/RuntimeSettings.ts`。
- **真实凭据、私有域名与生产配置一律不进被追踪文件**（`.env.example`、文档、测试只用虚构占位符或留空安全缺省）；代码默认值不得携带任何现网标识。详见根 `AGENTS.md`。
- 番剧图片的对外前缀写死为站内图床路径，**没有环境变量开关**（原因见 [BangumiApi](../Server/docs/BangumiApi.md)）。
- 客户端接口基址的唯一入口是 `VITE_SERVER_URL`，取值语义见 `Client/src/lib/ServerEndpoint.ts` 及其测试；同源还是跨域属部署口径，切换前提见 [Deployment](Deployment.md)。
- 遥测环境由统一的读取函数解析（显式环境变量优先，缺省为 development）；生产必须显式注入 production，不按操作系统猜测环境；Sentry 与 OTLP 消费同一结果。release 以仓库 Git/changelog 为准，无证据时为空，不硬编码版本、不采信任意 release 字符串。
- 公共图片统一转换为 WebP（表情的公共路径与内容哈希路径保留，单次有界编码后复制同一产物）。构建配置会重建生成目录，同一工作区必须串行构建；资源冒烟只服务已有构建产物，使用不加载项目配置与后端代理的独立 preview，绑定回环随机端口。
- 入站参数与规范化状态：局部输入与完整房间状态分别使用共享 Schema，类型由 Schema 的 `Static` 导出；服务端边界后补齐省略字段，客户端不得把局部输入当成完整快照。
