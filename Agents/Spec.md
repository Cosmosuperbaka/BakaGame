# 工程开发约束

本文档用于约束所有参与本仓库开发工作的 Coding Agents。执行需求分析、代码修改、代码审查和交付验证时，必须遵守以下规则。

## 1. 前端页面必须符合生产环境要求

- 本项目所有页面均视为正式上线的生产环境页面，不得按演示页面、概念稿或 Demo 的标准实现。
- 修改前端时，界面文案不得包含任何“设计风格说明”、主题名称或用于介绍视觉方案的描述性文字。
- 前端代码注释不得包含任何关于设计风格或主题名称的描述性文字。
- 所有用户可见文本必须是服务于真实使用场景的业务文案，不得使用展示性质、占位性质或解释设计意图的内容。
- 页面交互、状态反馈、异常提示和响应式表现应达到可直接上线使用的完整程度。

## 2. 优先使用原生标准与成熟生态，杜绝重复造轮子

- **核心宗旨**：前端和后端开发均应优先使用当前项目所采用框架、运行时与 Web/ECMAScript 原生标准能力。在不违背项目技术栈、不引入安全漏洞、不显著增加打包体积（Bundle Size）、且不降低代码易读性的前提下，坚决排查和替代代码库中自行手写的非业务核心基础逻辑。
- **重点审查与重构领域**：
  1. **复杂数据处理与算法**：深拷贝、深度合并、路径取值与变更、集合操作（Diff、交并集、去重、分组聚合）。坚决杜绝低效手写实现，优先采用成熟标准库（如基于 RFC 6902 的 `fast-json-patch`）或原生集合 API。
  2. **时间与字符串模式**：日期时间与相对时间计算必须优先使用原生标准 API（如 `Intl.RelativeTimeFormat`，并剥离至独立工具模块避免触发 Fast Refresh 规则）；URL 与参数解析必须采用原生 `URL`、`URLSearchParams` 等 WHATWG 标准，杜绝脆弱正则与手工字符串拼接；语义化版本比对必须使用工业级标准库（如 `compare-versions` 遵循 SemVer 2.0 规范）。
  3. **状态管理与数据流**：表单自动保存与对象脏检查杜绝渲染期频繁 `JSON.stringify` 序列化，优先采用高性能深度比较库（如 `fast-deep-equal`），消除对象键无序性引发的伪变更；全量与差量状态同步严格对齐行业开放标准。
  4. **网络通信与异步流程**：杜绝手写低阶递归计时器与轮询循环控制并发，必须采用成熟并发控制与退避调度器（如 `p-queue`），并在执行闭包内严防限流冷却期的微任务竞态；高并发数据缓存优先采用成熟 LRU 机制（如 `lru-cache`），彻底消除全量遍历扫描与内存泄漏风险。
  5. **协议校验与类型守卫**：通信层杜绝手写数百行命令式字段提取与类型守卫函数，必须充分利用框架生态（如 Elysia 内置 `@sinclair/typebox` 的 `t` 与 `@sinclair/typebox/value` 的 `Value.Check`）实现 Schema 契约定义与运行时校验单一真相源。
- **架构落地原则**：
  - **最小侵入原则**：仅触碰必要逻辑，严格保证现有业务输入输出、协议数据包格式、错误码和对外接口行为 100% 兼容。
  - **拒绝临时补丁（No Hacks）**：深入问题根因，杜绝“修修补补”和临时性 workaround，始终按高级开发者架构标准提供永久性解决方案。
  - **优先原生与框架内置**：优先使用 Web/Node/Bun 原生标准 API 或现有项目依赖（如 Elysia 导出能力），严禁盲目引入臃肿依赖全家桶。
  - **严苛验证闭环**：任何依赖替换与重构必须通过 TypeScript 类型检查（`bun run check`）、所有单测及全量回归测试（`npm run lint`、`npm test`、`bun test`、`npm run build`）。
- 后端基于 Elysia 开发。涉及 Elysia 的实现方式、接口或行为时，应优先参考其中文官方文档：<https://elysia.zhcndoc.com/>。
- 修改 Songuessr 的网易云音乐请求、Cookie、歌词清洗、播放地址或真实接口测试前，必须阅读 [`Agents/NeteaseMusicApi.md`](NeteaseMusicApi.md)，并遵守其中的缓存、频率限制、版权和凭据隔离约束。
- 修改听歌猜番的 Bangumi 请求、番剧筛选、主题曲解析或图床地址前，必须阅读 [`Agents/BangumiApi.md`](BangumiApi.md)，并遵守服务端请求、缓存限流、图片重写和答案隐私约束。
- 使用框架能力时仍须遵循本仓库现有架构、类型协议和代码组织方式。

## 3. 前端样式保持项目一致性

- 除非需求中另有明确说明，所有前端样式修改必须与项目现有整体样式保持一致。
- 样式和交互应保持简洁、直观、易用，不得为了视觉展示引入与现有产品不协调的布局、装饰或交互模式。
- 修改前应检查相关页面及相邻组件的既有实现，复用现有组件、样式约定和交互模式。

## 4. 任何更新绝不保留兼容代码与过渡期遗产 (Zero Legacy & Backward-Compatibility Elimination)

所有 Coding Agents 必须坚决执行“零遗产留存”与“代码单一真相源”原则。在项目演进、协议重构、模型升级或架构瘦身时，坚决消灭任何历史向下兼容代码与过渡期脚手架，杜绝技术债累积。

### 4.1 零过渡期向下兼容与双轨逻辑 (Zero Transition Backward-Compatibility & Dual-Tracks)
- **直接物理删除旧实现**：当需求明确替换路由、协议、配置、字段、存储键或交互规范时，旧实现必须直接从代码库中物理删除，**严禁**增加重定向、别名映射、双写、回退读取或兼容分支。
- **业务领域严禁预留伪开关字段**：严禁在业务领域模型、协议契约或后端配置项中预留无实体的“可用性伪开关与双轨回退分支”。在代码库中正式接入的业务功能即代表正式可用；主页等门户展示层若展示正在孵化中的子游戏 entry（如 CCB 增强版），应仅作为前端纯展示层呈现“即将上线”徽章与不可点击禁用状态，严禁反向向服务端协议与领域模型渗透临时兼容逻辑。
- **调用方全量同步重构**：替换旧规范时必须同步修改所有调用方、测试用例、文档与示例，确保仓库只剩当前唯一规范，坚决不能以“避免破坏已有外部使用”或“过渡期平滑迁移”为由保留旧入口或兼容层。
- **唯一例外需显式批准**：只有用户明确要求兼容特定旧版本时才允许增加兼容逻辑，且必须严格限定兼容生命周期与移除触发条件。

### 4.2 物理消灭过渡期 Shim 桥接文件与镜像单测 (Zero Shim Bridges & Redundant Suites)
- **严禁残留中转桥接文件**：在文件重命名、模块拆分或目录迁移后，**绝对严禁**在原路径保留仅包含 `export * from "..."` 或简单重新导出的 Shim / 桥接文件。
- **消费端导入必须一步到位**：迁移模块时必须同步更新所有消费端文件的 `import` 路径至目标权威文件。
- **镜像单测同步迁移与清理**：针对旧模块名的测试用例，必须同步将测试断言直接绑定至真实权威实现；对因重命名而产生的双胞胎、镜像重复单测，必须坚决予以物理删除，杜绝用例空转与认知噪音。

### 4.3 全栈消灭同音与大小写别名层 (Zero Alias Layers & Single Identity Invariant)
- **严格锁定单一真相源标识**：领域模型（Model）、通信协议（Protocol）、状态管理（Store/Context）、持久化（Storage）与网络客户端中，严格维持全栈唯一的权威命名。
- **彻底拔除同义别名导出**：坚决禁止为兼容历史拼写或过渡习惯而在契约层建立同义别名（例如：严禁 `SongGuessr*` 与 `SonGuessr*` 并存；严禁 `parseWhoIsFakerMessage` 与 `parseClientMessage` 并存；严禁 `useWhoIsFakerStore` 与 `useGameStore` 并存）。架构重构必须进行全局符号收敛，绝不保留过渡期别名。

### 4.4 坚守现代运行基线与拔除废弃私有前缀 (Evergreen Baseline & Zero Legacy Prefixes/Hacks)
- **锁定现代常青基线**：项目运行时与宿主环境严格对齐现代常青浏览器（Modern Evergreen Browsers）以及当前 LTS 运行环境（Bun / Node LTS）。
- **杜绝手动 Polyfill 与 UA 嗅探**：坚决杜绝手动编写任何已由现代引擎原生实现的 Web 标准 Polyfill（如 Fetch、Promise、ResizeObserver 等），坚决禁止基于 `navigator.userAgent` 判断老旧浏览器版本的 Hack 分支。
- **CSS 样式标准化**：样式必须完全遵循现代 CSS 规范，坚决剔除早就不再需要的私有厂商前缀（如 `-ms-overflow-style`、`-webkit-scrollbar*` 伪元素侵入性定制），统一采用标准滚动条行为与现代原生交互规范。

### 4.5 严禁级联回退链与边界阻断脏字段 (No Fallback Chains & Strict Boundary Invariants)
- **杜绝深层级联回退链**：严禁在业务域中堆砌多层级联兜底（如 `a ?? b ?? c ?? d` 或 `res.songs ?? res.result?.songs`）。状态必须在服务端建立单一权威真相源并在快照中显式下发，消费端直接且仅消费权威字段。
- **输入边界拦截与去脏字段探测**：网络通信协议的 DTO 反序列化与校验边界（如 TypeBox `t.Object`）必须显式声明 `{ additionalProperties: false }`，在系统边界直接拒绝非预期冗余字段；纯业务逻辑域中严禁编写 `if ("legacyField" in data)` 等命令式探测与向前兼容逻辑。

### 4.6 网关与容器依赖注入绝对唯一 (Strict Dependency Injection Naming)
- **消除依赖注入双轨命名**：网关路由装配（如 `App.ts`）与依赖注入容器（`AppDependencies`）中，每个服务与基础设施依赖必须锁定唯一的权威命名（例如：必须使用 `whoIsFakerService`，严禁在同一容器或参数中同时支持 `roomService` 与 `whoIsFakerService` 的双轨回退注入）。

Songuessr 当前唯一公共入口为前端 `/songuessr` 和 WebSocket `/api/songuessr/ws`；不得重新添加旧路径或旧存储键。


## 5. 工程约束与审查规范的持续沉淀 (Continuous Governance & Review Sync)

- **审查规范强制同步固化**：所有 Coding Agents 在执行任何类型的专项审查（包括但不限于架构与 DDD 审查、防御性编程审查、代码异味排查、性能与资源消耗审查、安全与权限审查、类型契约审查等）时，凡是审查中提炼确立、得到确认的设计准则、工程约束、坏味道负面清单或不变量法则，**必须在整改或交付阶段第一时间同步写入 `Agents/` 系列规范文档中（通用约束写入本文，领域专用约束写入对应子文档）**。
- **杜绝临时性治理**：严禁将审查成果与整改规则仅停留在单轮对话、临时任务清单（如 `tasks/`）或 PR 说明中；审查的终点必须是“制度化资产”，确保所有后续接手的 Agents 与人类工程师永久遵守同一套经过审查检验的标准，实现“一次审查，全域永久生效”。
- **用户后续追加约束的维护**：用户后续提出的任何全局或专项工程约束，必须继续归纳写入本文件或相关文档，作为全仓库 Coding Agents 的唯一真实信任源（Single Source of Truth）。
- **表述清晰与冲突处理**：新增约束时应使用清晰、可执行、带正反例的硬性表述；若新规范与旧规则存在冲突，严格以最新确认的规范为准，并同步重构清理旧章节，严禁保留模棱两可或互相矛盾的规则。

## 6. Git 提交规范

- **提交时机：每完成一个点的修改立即提交，严禁等到所有修改完成后再集中进行原子化提交**。在处理多项任务或复杂重构时，严禁积攒大量改动后统一提交或事后批量补提。每一个独立功能点、修复点或重构子项在跑通针对性测试与必要验证后，必须第一时间执行独立的 Git 提交。
- 每个提交只包含一个独立、完整且可说明的功能、修复或文档变更，不得混入无关修改。
- 同一需求包含多个可独立交付的功能时，应拆分为多个提交；彼此不可分割的配套修改（如修改 shared 协议及两端消费端）应保留在同一提交中。
- 提交前必须检查暂存区内容，确保没有纳入用户已有的无关改动、临时文件或生成物。
- Commit Message 必须遵循 Angular 提交规范，格式为 `type(scope): 中文摘要`，其中摘要必须使用中文。
- `type` 应根据变更性质选择 `feat`、`fix`、`docs`、`style`、`refactor`、`perf`、`test`、`build`、`ci`、`chore` 或 `revert`。
- `scope` 必须填写受影响游戏的缩写，取值为 `Faker`、`Song`、`CCB`，公共能力、基础设施与站点主页使用 `Core`。具体对应关系、提交时机与版本号规范见 `Agents/Commitment.md`。
- 中文摘要不得超过 12 个中文字；超出时必须继续拆分提交，直到每条提交的摘要都满足该限制。
- 存在正文或破坏性变更说明时，正文和说明也必须使用中文，并保持内容准确、简洁。
- 示例：`feat(Faker): 增加投票撤销入口`、`fix(Faker): 修复提前结算`、`docs(Core): 更新提交约束`。

## 7. 实时网络必须节约带宽

- WhoIsFaker 与 Songuessr 的实时状态默认使用带修订号的增量消息，不得在每个业务动作后无条件向全房重复发送完整快照或未变化的私有状态。
- 状态通道必须保留最终同步能力：首次加入、重连、客户端发现修订号缺口、补丁应用失败、周期校准（挂在 10 秒 housekeeping 节奏上，每通道独立按 60 秒计时触发）、自上次全量起补丁数累计达到 1024、以及单次补丁序列化体积达到全量快照体积的 82% 及以上时强制发送完整状态；客户端不得在缺少基线时猜测或跳过补丁。
- 同一事实只能通过一个生产通道发布。若版本化状态已经包含该变化，不得再广播客户端不消费的重复事件；聊天等列表变化也不得同时由事件追加和状态补丁追加。
- 文本输入、高频草稿和自动保存必须防抖或合并，连续修改只提交最新值；不得按每个按键触发全房广播。
- 生产 WebSocket 必须优先保证各平台连接兼容性。当前 Bun 无法按客户端稳定控制 `permessage-deflate` 协商，且该扩展会导致部分 iOS WebKit 客户端无法连接，因此全局关闭消息压缩；只有在运行时支持可靠的按客户端协商且完成 iOS 回归后才允许重新启用。
- 修改公开快照、私有状态、广播频率或传输封包时，必须运行 `Server/test/NetworkCapacity.test.ts`。基线为 150 个 WhoIsFaker 在线玩家、每秒 12 次状态变化、每分钟一次全量校准，并计入 WebSocket 帧与 15% 传输余量；估算出口不得超过 6 Mbps。

## 8. 杜绝过度防御性编程、掩耳盗铃式兜底与补丁式修 Bug

所有 Coding Agents 必须严格遵循领域驱动设计（DDD）思想与“Parse, don't validate”哲学。在数据源头与系统边界上建立不变量（Invariants），使非法状态在结构上不可表达；严禁为了“防止眼前报错”而堆砌创口贴补丁或掩耳盗铃式兜底。

### 8.1 严禁深层防御性判空蔓延 (Anti-Defensive Null Sprawl)
- **入口立契约，内部去噪音**：必须在系统入口处（API Gateway、WebSocket 消息路由分发、DTO 解析、Store 事件响应入口）建立严格的运行时校验（如 TypeBox `Value.Check` 或统一断言）。一旦数据进入内部纯业务域，函数必须直接信任上游传入的强类型，严禁内部纯业务函数每一层都重复写 `if (!user) return` 或滥用多层深层可选链（`a?.b?.c?.d`）。
- **杜绝用异常做常规控制流**：业务规则探测（如判断当前人数是否满足角色配置）必须提供无副作用的纯计算谓词（如 `isRoleConfigSatisfied(config, count): boolean`）。**严禁**使用 `try { validateX(...) } catch { return false }` 作为探测布尔分支的反模式，避免浪费 V8 调用栈并掩盖真实异常。

### 8.2 严禁掩耳盗铃式兜底与虚假实体伪造 (No Cover-Up Fallbacks & Fictitious Entities)
- **仓储层与 IO 错误必须 Fail-Fast**：持久化读写时，必须严格区分“资源不存在（如文件首创 `ENOENT`）”与“数据损坏/语法错误”。在遇到损坏数据、非预期格式时，必须坚决抛出明确业务异常（Fail-Fast），**绝对严禁**捕获异常后静默返回空数组（`[]`）或空对象（`{}`）充当兜底。此类看似安全的“兜底”会在后续写入时执行致命覆盖，导致用户历史数据被永久清空。
- **严禁在展现层凭空制造全属性假实体**：在 UI 组件或视图模型中，严禁为了满足过宽的类型约束而在遍历中用对象字面量凭空伪造包含业务状态的领域模型（如虚构 `membership: "active"`, `score: 0`, `roundStatus: "waiting"` 的 `PublicPlayerView`）。视图层需要什么字段，就抽象精简的展示接口（如 `{ id, name }`），杜绝制造虚假领域状态。
- **严禁多层级联失效兜底链**：杜绝出现 3 层及以上的 `a ?? b ?? c ?? d` 回退链。若核心状态需要顺序，必须在服务端建立单一权威真相源并在快照中显式下发，客户端直接消费权威字段。

### 8.3 严禁补丁式修 Bug 与时序延时欺骗 (No Patchwork Hacks & Artificial Delays)
- **严禁使用 `setTimeout` 掩盖时序竞态**：在 UI 刷新、网络请求或状态重置的生命周期中，**严禁**使用 `setTimeout(..., 500)` 或 `window.setTimeout` 制造人造延迟或试图“避开并发竞态”。加载状态必须严格与真实的 Promise/异步操作生命周期对齐。
- **严禁客户端篡改与拦截服务端权威状态**：状态管理容器（Zustand Store）必须保证服务端权威快照单向流入。**绝对严禁**在客户端编写类似 `normalizeSnapshot` 拦截服务端的合法阶段（如把 `gameOver` 篡改为 `waiting`，或延时推迟快照生效），杜绝破坏服务端状态机单调推进与幂等性。
- **根因治理，拒绝创口贴标志位**：面对偶发的并发冲突或时序错乱，必须追溯状态源头、事件触发顺序与生命周期钩子，彻底修正状态流；坚决禁止通过局部打补丁、添加 `isFixingBugX` 标志位或外部全局变量打游击。

## 9. 数据流与状态不变量工程铁律 (State & Data Invariants)

在分布式 WebSocket 实时协同、长流程有限状态机与并发异步交互场景下，必须建立无缝自洽的数据流与状态不变量，杜绝时序死锁、重复扣减、幽灵更新与缓存击穿。

### 9.1 并发写与异步 I/O 竞态治理：前置占位与加锁 (Pre-allocate, Lock, Post-verify & Rollback)
- **严禁在 `await` 之后校验配额**：高并发异步操作（如猜歌、选票、扣款、答题）若包含异步 I/O（如外部歌词/音源加载、数据库查询、大模型调用），**绝对严禁**在 `await` 外部 I/O 之后才检查/扣减配额。这会导致并发请求在 I/O 挂起窗口内全部穿透校验，发生配额击穿。
- **模式标准：前置占位递增 + In-flight 互斥 + 异常安全回滚**：
  1. **同步原子扣减/占位**：在让出事件循环（`await`）之前，立即递增计数（如 `state.guessesUsed++`）并校验上限。
  2. **并发飞行锁（In-flight Lock）**：针对同一会话/实体，使用 `Set<string>` 或 Map 标记当前正在进行的并发任务，并发调用直接阻断（Fail-Fast）。
  3. **异常安全回滚（Rollback on Failure）**：在 `try...finally` 中若异步外部过程发生不可恢复的网络或系统异常，必须在 catch 中将预占配额补偿回滚，并由 finally 释放锁。

### 9.2 阻塞阶段生命周期必须闭环 (Guaranteed Deadlock Elimination)
- **严禁设计无推进条件的半开状态**：任何游戏或业务长流程中，若状态机进入独占或阻塞阶段（如白板猜词、答题倒计时、出题人裁定、PK 演讲），必须同时满足：
  1. **主动交互推进路径**：正常参与者提交操作推进阶段。
  2. **全周期硬超时保底（Hard Deadline）**：服务端必须设定全局不可突破的超时上限（如 `hardDeadlineAt` 或 `phaseTimer`）。即使用户网络断开、音频加载失败、第三方 API 挂起，超时触发时必须强行推进至下一阶段或回滚原阶段，杜绝房间陷入不可逆死锁。
  3. **掉线巡检与等待兜底**：当关键阻塞操作人（如猜词白板、发言人）意外掉线且其他人选择“等待”时，系统必须强制挂载有限兜底倒计时（如 60 秒），到期无缝恢复游戏流程，杜绝无限期挂起。
- **状态打断与上下文恢复保真**：阶段被打断暂停（如发言中被白板猜词插队）时，必须暂存原阶段的真实剩余时间（`interruptedRemainingTimerMs`）。打断退出或裁定未通过返回时，必须恢复对应时长的倒计时，禁止将打断后剩余时间抹去或直接重置为初始时长。

### 9.3 协议快照与展示派生状态严格物理隔离 (RFC 6902 Base Isolation & Clean Re-anchoring)
- **协议原始基线不可篡改**：客户端消费 RFC 6902 JSON Patch 时，状态同步引擎（如 `StateSync.ts`）维护的快照基准必须严格等于服务端原生下发的公开数据模型。**绝对严禁**在协议快照对象上就地（in-place）追加前端私有展示字段（如向 `snapshot.chat` 中 push 本地系统提示），否则会导致 JSON Patch 的数组索引与属性路径错位，引发补丁应用崩溃或幽灵数据。
- **换房与退房基准原子重置**：当客户端离开房间或切换房间时，必须彻底重置所有模块级版本追踪号（`lastRevision = 0`）、历史补丁缓存与基线快照引用，杜绝上一个房间的残留版本号阻断新房间的快照同步。

### 9.4 前端多层防重与网络层 Envelope 幂等 (Multi-tier Idempotency & Envelope Deduplication)
- **UI 视图层防重锁**：所有提交类按钮（开始游戏、提交发言、投票、猜歌、保存配置）在网络请求发出至收到 ACK 或失败前，必须在组件层挂载 `in-flight` 禁用锁与加载反馈，杜绝连续快速点击发送重复封包。
- **传输信封幂等去重（Envelope Deduplication）**：网关或传输层（如 `App.ts`）针对带有客户端唯一 UUID（`id`）的消息信封，维护带 TTL 的 LRU 缓存与飞行锁。在短时间窗口内到达的相同 `id` 重复封包直接返回缓存的 ACK，严防网络重传或重试造成业务重复执行。

### 9.5 React 卸载副作用清理必须校验前置业务阶段有效性守卫 (Unmount Safeguard & Phase Guards)
- **严禁向失效阶段脏回写**：带有自动保存（`useAutoSave`）或防抖延迟写入的 React 组件，在离开视口或 unmount 时，**必须**同步校验当前业务阶段是否依然处于允许保存的合法阶段（如 `snapshot.status.phase === "waiting"`）。组件卸载时若已经开局或阶段已跃迁，必须立即丢弃待提交的脏草稿，严禁向服务端发送非法的配置覆盖请求。

## 10. 可观测性与生产运维就绪度工程铁律 (Observability & Production Readiness)

在无状态容器、微服务架构与云原生部署环境下，必须具备生产级透视能力与自愈容灾能力，杜绝“无日志、吞异常、无 Trace 上下文、粗暴停机导致数据损坏”的运维灾难。

### 10.1 全链路追踪与会话隔离 (Distributed Tracing & Session-Scoped Idempotency)
- **全局唯一 Trace ID 贯穿始终**：客户端每次与服务端的交互（HTTP 请求、WebSocket 连接与命令交互）必须生成全局唯一的 Trace ID（包含时间戳、单调计数器与随机熵），严禁使用单调自增小整数（如 `req-1`）作为跨连接的请求标识。
- **传输层幂等缓存必须与会话隔离**：网关或传输层维护的 LRU 缓存与并发飞行锁（In-flight Lock）键，必须使用带有连接唯一 ID 的复合键（`${connectionId}:${id}`）。**绝对严禁**使用客户端传入的原始 ID 作为跨所有租户的全局缓存键，杜绝跨玩家并发响应串扰与串台。
- **全链路透传与上下文字段保真**：HTTP 网关必须在响应头显式返回 `x-trace-id`；WebSocket 协议中 `createAck`、`createErrorPacket` 必须回传 `traceId`；日志系统必须将 `traceId` 提取为一级索引字段。

### 10.2 结构化日志、堆栈保真与敏感凭据脱敏 (Structured Logging, Stack Fidelity & Sensitive Redaction)
- **严禁吞异常与裸字符串报错**：杜绝任何形式的空 `catch {}` 或仅打印无上下文的 `console.error("error")`。所有捕获异常必须调用结构化日志接口（如 `eventLogger.error`），并使用 `describeError` 递归保留 `error.name`、`error.message`、`error.stack` 以及 `error.cause` 完整链路。
- **结构化元数据不丢失**：日志记录函数必须将所有附加业务元数据（如 `roomId`、`playerId`、耗时、阶段快照）全部序列化并输出，严禁只输出静态标题而将上下文丢弃。
- **敏感信息严格物理脱敏**：
  1. `cookie`、`sessionToken`、`authorization` 等身份凭证在日志输出或导出前必须经过脱敏拦截器（`redactData`），保留前 4 位用于故障定位，后续字符强制掩码（`abcd***[REDACTED]`）。
  2. `password`（密码）属于顶级高危凭据，必须 100% 全量掩码（`***[REDACTED]`），绝对严禁保留任何明文字符。

### 10.3 云原生健康检查探针拆分 (Kubernetes Liveness & Readiness Probes)
- **Liveness 探针 (`/livez`)**：轻量级存活探针。仅验证进程是否存活、事件循环是否运行，未死锁即返回 HTTP 200 `{ status: "ok" }`。探测开销必须为 `O(1)`，不得在此阶段挂载重型数据库或外部 I/O 检查，避免短暂抖动触发容器反复被杀重启。
- **Readiness 探针 (`/readyz`)**：深度就绪探针。必须检测：
  1. **停机状态守卫**：若收到停机信号进入优雅停机流程，立即返回 HTTP 503 `{ status: "shutting_down", ready: false }`，使外部负载均衡器/反向代理（Nginx/Ingress）立即停止分配新连接与流量。
  2. **关键持久化依赖**：检查词库仓储（`wordBankRepository.checkHealth()`）等底层持久化介质读写健康度。若底层磁盘损坏或权限缺失，返回 HTTP 503 `{ status: "storage_degraded", ready: false }`，避免故障节点继续承接业务流量。
  3. **存量监控兼容**：保留 `/health` 路由，聚合房间、在线连接与玩家数指标，兼容常规监控大屏。

### 10.4 生产级优雅停机编排 (Graceful Shutdown & Watchdog Orchestration)
- **优雅停机 6 步标准时序**：
  1. **标记停机状态**：将 `isShuttingDown` 置为 `true`，触发 `/readyz` 熔断返回 503。
  2. **清除后台轮询**：停止闲置房间清理、心跳超时扫描等定时器，阻止启动新的巡检。
  3. **在线长连接广播**：向所有在线玩家（WhoIsFaker 与 SonGuessr）全量广播 `server.shutdown` 事件，通知客户端准备重连。
  4. **流量摘除平滑缓冲窗口**：执行 3 秒（`await Bun.sleep(3000)`）等待，留出反向代理摘流切换与客户端接收停机事件的稳定网络窗口。
  5. **排空写队列落盘**：等待词库异步持久化队列（`drainPendingWrites`）全部排空，杜绝进程退出引发磁盘文件截断或数据丢失。
  6. **关闭端口与排空遥测**：停止 HTTP/WebSocket 监听端口（`app.stop(true)`），排空并刷新未导出的 OTLP 遥测日志，正常退出进程。
- **看门狗超时保底**：停机信号触发时，必须挂载 15 秒非阻塞看门狗定时器（`setTimeout(..., 15000).unref()`）。若外部 I/O 或套接字挂起超过 15 秒，看门狗强制调用 `process.exit(1)` 退出，防止进程永久僵死。
- **致命异常全局捕获**：必须注册 `process.on("unhandledRejection")` 与 `process.on("uncaughtException")`。未处理 Promise 拒绝记录 ERROR 日志，未捕获同步异常记录日志并触发优雅停机。

### 10.5 Sentry 全栈异常托管与同源隧道防拦截架构 (Sentry & Tunnel Gateway)
- **统一异常捕获与托管**：前端基于 `@sentry/react` 与 `Sentry.ErrorBoundary` 全局托管组件崩溃与异步未处理异常；服务端基于 `@sentry/bun` 全局托管未捕获 Promise、同步异常与 HTTP/WS 500 级故障。
- **同源隧道反代与防广告拦截 (Sentry Tunnel)**：前端 Sentry 上报统一通过服务端同源反代路由 `/api/monitoring/sentry` 中转。服务端路由对 Envelope Header 的目标主机与 Project ID 执行白名单鉴权，杜绝开放式代理（Open Relay）与内网 SSRF 探测，彻底免疫浏览器广告拦截插件（AdBlocker）误杀，保障中国大陆玩家顺畅直连。
- **标准环境变量支撑**：前端通过 `VITE_SENTRY_DSN` 注入客户端上报凭据；服务端通过 `SENTRY_DSN` 与 `SENTRY_ALLOWED_PROJECT_IDS` 注入服务端凭据与隧道校验白名单。现有标准 OpenTelemetry（`OTEL_EXPORTER_OTLP_*`）与 EventLogger 继续保障对局事件落盘审计与双轨观测。
- **心跳上报间隔必须收敛于 Monitor 判定裕度内**：服务端 Cron Monitor（`bakagame-server-heartbeat`）排程为 `*/5 * * * *`、`checkin_margin` 为 2 分钟，即只在 `[T, T+2min]` 窗口内收到 check-in 才判定为按时；窗口之间（`T+2min` 至 `T+5min`）不存在任何容错区间。服务端心跳上报间隔（`SERVER_HEARTBEAT_INTERVAL_MS`）**必须不大于判定裕度**，且必须与 Monitor slug 同居同一真相源模块；严禁凭“留出网络与调度余量”的直觉把间隔拉长到接近排程周期，否则必然跨过窗口间隙被误报为 `missed check-in`。
- **客户端异常过滤必须覆盖全部浏览器引擎文案**：客户端 `ignoreErrors` 严禁只覆盖单一引擎文案。网络与模块加载失败必须同时覆盖 Firefox（`NetworkError when attempting to fetch resource.`）、Safari（`Load failed`）、Chromium（`Failed to fetch dynamically imported module`、`Loading chunk N failed`）与 WebKit（`Importing a module script failed`）四套文案，否则同一类失败会因引擎措辞不同而漏网。带锚点的短文案（如 Safari 的 `Load failed`）必须加 `^` 锚定，严禁裸用裸串造成 `Image load failed` 之类无关文案被误伤。这类失败已由自愈重载兜底，不得重复上报污染真实缺陷信号。
- **瞬时外部干扰必须自愈，且重载严格限流**：分块加载失败与第三方扩展改写 DOM 破坏 React 父子节点不变量（`removeChild`、`insertBefore`）同属"外部干扰、重载即恢复"，**必须**自动重载让玩家无感恢复，严禁只把玩家丢在错误兜底页。但**所有**自动重载必须经由统一的会话级一次性门闩（`reserveSessionRecovery`）放行：同一浏览器会话内同一恢复点位只允许重载一次，杜绝真实缺陷引发无限重载循环；浏览器禁用存储时必须安全拒绝放行并按原样抛出真实错误，严禁把存储异常伪装成加载失败，也严禁各处自行裸写 `sessionStorage` 判定。
- **协议层错误应答是数据，严禁上报为异常事件**：WebSocket 客户端（`WebsocketClient`）收到的服务端 `error` 包承载的是可预期的业务拒绝（`ROOM_NOT_FOUND`、`PASSWORD_INCORRECT`、`INVALID_PHASE`、`NO_ACTIVE_ROUND` 等），与断连、超时、未连接同属正常协议应答，一律只记录指标与日志；**只有**非协议错误体（真正的 Error）才允许 `captureException`。严禁把可预期的拒绝原样包装成 `new Error()` 上报 —— 否则玩家每输错一次房间密码都会伪造一条缺陷记录。判定必须基于唯一的类型守卫 `isProtocolError`，严禁各处重复实现形状探测。
- **模块脚本解析失败按栈帧剔除，禁止按文案猜测**：浏览器拉到的模块脚本若响应体不是合法 JS（边缘节点返回的畸形或占位响应），会以 `SyntaxError: Unexpected token '{'` + 内建 `parseModule` 帧的形式抛出。该文案与 JSON 解析错误同形，`ignoreErrors`（仅匹配异常文案）无法精确表达，必须改用事件组装阶段的 `beforeSend` 判定：仅当异常类型为 `SyntaxError` **且** 栈帧中出现 `parseModule` 时才丢弃。严禁为图省事直接按 `Unexpected token` 之类裸文案过滤，那会连同真实的数据解析缺陷一起吞掉。

### 10.6 绝对凭据隔离与防私有服务及密钥泄漏铁律 (Zero-Secrets & Credential/Mirror Isolation Invariant)
- **严禁向 Git 仓库提交真实凭据与私有域名**：无论属于公钥、私钥、Token、项目标识（包括 Sentry DSN、API Token、网易云 Cookie、账号密码、第三方 Secret 以及真实 Project ID），还是开发者个人或自建的私有服务端点（如自建 Bangumi 图床镜像、私有反向代理域名、内网穿透与自建 API 地址），一律绝对严禁写入被 Git 追踪的任何文件。
- **示例文件与测试用例全量 Dummy 化与安全缺省**：所有 `.env.example`、文档示范及单元测试代码，必须且只能使用通用的纯虚构占位符（如 `https://examplePublicKey@o000000.ingest.sentry.io/0000000`、`100001`、`dummy-token`、`https://mirror.example.com`）或留空安全缺省值（如 `BANGUMI_IMAGE_URL=`），严禁粘贴任何真实环境的 DSN、实际项目标识与私有镜像域名。
- **私有凭据与自建服务单一物理隔离**：真实配置必须且只能存在于被 `.gitignore` 严格忽略的本地私有 `.env`、`.env.local` 文件或云原生容器平台环境变量中。代码默认值与 Fallback 严禁携带任何现网项目标识或自建私有域名。
- **本地未推送提交泄漏必须立即净化提交历史**：若在本地尚未推送到远端的提交中误写入了私有凭据或私有域名，严禁通过仅仅追加一个覆盖提交草草掩盖，必须在分支推送前通过变基（Rebase）彻底净化未推送提交历史，从 Git 对象树根源消灭泄露痕迹。

## 11. 平台与多游戏平等架构契约 (Multi-Game Equal Status Architecture Contract)

在 BakaGame 平台中，所有小游戏（包括谁是卧底 `WhoIsFaker`、猜歌达人 `SonGuessr`、未来扩充的 `CCB` 等）具有严格平等的架构地位。严禁将任何单一游戏作为“平台核心/宿主”而将其他游戏贬为“二等公民或附加插件”。

### 11.1 共享模型与协议单向无环分层 (Acyclic Shared Contracts)
- **分层边界与单一真相源**：
  1. **平台通用核心层 (`Server/src/shared/Protocol.ts`, `Model.ts`)**：仅承载跨所有游戏通用的数据结构与基础设施契约（如 `ClientEnvelope` 通用信封、`AckPacket`、`ErrorPacket`、`EventPacket`、`StateSyncPayload`、`ROOM_ID_TEST_MODE`、`isValidRoomId`、`RoomVisibility`、`PlayerMembership`、`ChatMessage`、`ConnectionRecord`）。
  2. **游戏专属领域层 (`Server/src/shared/{GameName}.ts`)**：每个小游戏拥有独立、对等的模型契约文件（如 `WhoIsFaker.ts`、`SonGuessr.ts`、`CCB.ts`）。各个游戏领域层只能单向依赖平台核心层，严禁游戏领域契约之间产生跨游戏横向依赖。
  3. **统一入口层 (`Server/src/shared/Index.ts`)**：作为 `@bakagame/shared` 的总门面，对等汇集并导出 `Model`、`Protocol` 以及各个子游戏的领域模块。
- **消除信封与数据包格式的重复定义**：所有游戏的客户端指令信封联合体（如 `WhoIsFakerClientMessage`、`SonGuessrClientMessage`）必须统一基于平台通用的泛型信封 `ClientEnvelope<TType, TPayload>` 进行特化，严禁在各自业务契约中重新手写同构的信封接口。

### 11.2 传输层与协议解析对称性 (Symmetrical Transport & Message Parsing)
- **核心封包工具剥离 (`Server/src/transport/Packets.ts`)**：
  - `createAck`、`createErrorPacket`、`createEvent` 属于平台通用传输工具，必须收敛于纯粹的 `Packets.ts`。严禁任何子游戏服务反向引入掺杂其他游戏解析逻辑的协议文件。
- **解析器与路由入口对称**：
  - 每个子游戏拥有独立的解析器：`WhoIsFakerProtocol.ts` 导出 `parseWhoIsFakerMessage`，`SonGuessrProtocol.ts` 导出 `parseSonGuessrMessage`。
  - 网关路由（`App.ts`）对称消费各游戏的专用解析器，并以平等的路由前缀（如 `/api/whoisfaker/ws` 与 `/api/songuessr/ws`）挂载独立的 WebSocket 会话。

### 11.3 服务编排与依赖注入对等性 (Equal Service Orchestration & Dependency Injection)
- **领域服务命名与单一真相源**：
  - 服务端领域服务统一由具名核心实体独立提供（由 `WhoIsFakerService` 与 `SonGuessrService` 严格对齐），坚决杜绝任何一方使用泛化的 `RoomService` 或建立过渡期兼容导出别名。
  - 应用依赖定义（`AppDependencies`）与构造器返回值中，`whoIsFakerService` 与 `sonGuessrService` 具有完全一致的一级依赖注入地位，坚决杜绝 `songGuessrService` 或 `roomService` 等双轨冗余别名字段。
  - 系统级探针路由（`systemRoutes`）在聚合统计与健康巡检时，平等读取并汇总各个游戏服务的运行快照。

### 11.4 客户端组件复用与表现层对等契约 (Equal Component Architecture & Zero Cross-Game Infiltration)
- **跨游戏交互基建强制提升至 `common/`**：凡是涉及两个及以上游戏同构的核心交互组件（如聊天面板 `ChatPanel`、玩家状态胶囊徽章与行布局基底 `PlayerStatusPill`、玩家分组标题 `PlayerGroupTitle`、表情包选择器 `EmojiPicker` 等），**必须且只能**提升至 `Client/src/components/common/`，通过解耦的 Props 与回调注入驱动数据，严禁直接硬编码耦合任何单个游戏的专属 Store。
- **严禁游戏领域跨目录横向依赖 (Zero Cross-Game Infiltration)**：任何游戏专属子目录（如 `components/whoisfaker/` 与 `components/songuessr/`）之间，**绝对严禁**产生横向交叉导入（例如严禁猜歌组件从 `whoisfaker/` 导入 UI 组件、布局或样式常量）。所有通用能力必须且只能由 `components/common/` 向上提供。
- **目录命名与组件命名绝对平等 (Equal Namespace & Symmetrical Naming)**：
  1. **目录拼写严格单一真相源**：游戏组件目录必须遵循 `Conventions.md` 约定的全小写单一规范（如统一使用 `components/songuessr/`，严禁拼写漂移如 `songguessr`）。
  2. **消除命名特权与二等公民双标**：在各游戏的专属子目录内，组件必须遵循对等的命名法则（如各自命名为 `PlayerList.tsx`），严禁一方霸占无前缀基础短名，而另一方被强加冗余的游戏前缀（如 `SongPlayerList`）。
  3. **全局基础 UI 容器去特定业务耦合**：全局通用弹层与容器组件（如 `Toast.tsx`）严禁被单一游戏独占无前缀基础名，且严禁基础 UI 组件反向依赖特定业务 Store。
- **系统消息与阶段提醒样式标准**：聊天流中的系统提示与阶段流转通知，统一采用**无背景纯文本居中展示**（`min-w-0 whitespace-pre-wrap py-1 text-center text-xs text-muted-foreground/70`），坚决杜绝嵌套灰色胶囊药丸背景（`rounded-full bg-muted/40`），保持全站纸质复古质感与通透排版。

## 12. 边界情况与跨环境适应性工程铁律 (Environment & Edge Cases Invariants)

代码必须兼具本地单机开发、多时区全球用户访问、移动端局域网联机、生产多容器编排与大负载边缘网关的跨环境适应性，杜绝“本地开发良好、生产部署爆雷”的隐形缺陷。

### 12.1 时区与时间模型不可变量 (Timezone Invariants & ISO-8601 Standards)
- **服务端日志与接口时间全量标准化**：服务端控制台日志、持久化记录及 HTTP/WebSocket 接口下发的时间戳，必须严格锁定标准 ISO-8601 UTC 格式（`toISOString()`）或 UTC 毫秒时间戳。严禁使用 `new Date().getHours()` 等裸本地时区函数拼接无时区偏移的日志时间戳，消除跨地域多容器日志采集（Loki/ELK）乱序与时钟漂移。
- **客户端业务时间显式锁定目标时区**：涉及账号有效期限、账务日、版本生效等业务日期展示时，禁止调用无参 `toLocaleDateString()`。必须通过 `Intl.DateTimeFormat` 显式锁定语言（如 `zh-CN`）与基准时区（如 `Asia/Shanghai`），防止跨时区客户端或不同操作系统语言导致有效日期偏移整天，并消除 SSR 两端 Locale 差异导致的水合崩溃。
- **相对时间渲染水合保护**：在服务端渲染（SSR/SSG）或混合渲染架构下，动态相对时间计算节点（如 `formatRelativeTime`）必须在渲染标签上标记 `suppressHydrationWarning`，杜绝网络传输延迟引起的水合文本不一致。

### 12.2 跨端非安全上下文与局域网韧性 (Non-Secure Context & LAN Play Resilience)
- **非安全上下文 UUID 降级**：客户端信封 ID 与 Trace ID 生成严禁硬性假设存在 `crypto.randomUUID()`。在 HTTP 局域网访问（如移动端通过 `http://192.168.x.x` 接入主机联机对局）等非安全上下文（Non-Secure Context）下，必须提供符合 RFC 4122 v4 的伪随机降级生成算法，严禁抛出 `TypeError` 阻断对局。
- **网关局域网网段放行**：服务端网关层（`App.ts`）的来源校验必须对私有局域网网段（RFC 1918：`192.168.0.0/16`、`10.0.0.0/8`、`172.16.0.0/12`）予以放行，保障真机面对面局域网联机体验。
- **客户端地址归一化防双斜杠**：前端根据环境变量构建 WebSocket/HTTP 地址时，必须正则剥离基准地址末尾的所有斜杠（`.replace(/\/+$/, "")`），防止拼接产生 `//api` 路径，避免严格反向代理（Nginx/Cloudflare）返回 404 或因不支持 301/308 重定向导致长连接握手失败。

### 12.3 容器网络与部署寻址解耦 (Container Network Binding & Path Decoupling)
- **监听网卡与公开地址解耦**：服务端内部套接字绑定主机（`serverListenHost`）必须与对外公开地址（`SERVER_URL`）解耦。在容器化环境中默认监听 `0.0.0.0` 全网卡，杜绝仅绑定 `127.0.0.1` 导致外部 Ingress 或 Docker 端口映射连接被拒（`Connection refused`），并支持 `SERVER_LISTEN_HOST` 覆盖。
- **环境文件寻址必须基于模块定位**：持久化介质（词库 `wordBankPath`、文档导出路径等）默认必须基于当前模块文件路径（`import.meta.dir`）进行稳定相对寻址，杜绝依赖不可控的 `process.cwd()`；同时提供标准环境变量（如 `WORD_BANK_PATH`）以支持云原生外挂数据卷（Persistent Volume）。
- **环境变量强断言快速失败**：启动期解析环境变量（如 `SERVER_PORT`）时必须校验合法范围（1~65535），非法或空输入立即抛出 `AppError("CONFIG_ERROR", ...)` 快速中断退出，严禁静默回退为 0 导致随机占用系统临时端口。

### 12.4 跨域预检完整性与大载荷防 OOM (CORS Preflight & OOM Defense)
- **跨域 HTTP 方法与追踪头对称开放**：反向代理与全局 CORS 配置必须对称覆盖所有业务端点的方法（`methods: ["GET", "POST", "OPTIONS"]`），并将分布式追踪头（`allowedHeaders: ["content-type", "x-trace-id"]`）纳入预检放行，严防生产前后端分域部署时遥测打点被静默拦截。
- **WebSocket 协议层单帧硬上限**：WebSocket 网关必须显式配置单帧载荷上限（`maxPayloadLength: 256 * 1024`，256KB），杜绝恶意攻击者单帧灌入超大包耗尽边缘容器内存。
- **监控上报请求体 Schema 强校验**：遥测打点接口必须配置严格的 Elysia 请求体 Schema，限制消息与嵌套元数据长度；脱敏函数 `redactData` 必须包含最大递归深度保护（`maxDepth = 5`），杜绝深层或循环引用引发栈溢出。
- **OTLP 链路导出失败不丢数据、有限指数退避重试与有界淘汰指标契约**：OTLP 导出器（`OtlpExporter`）必须设定固定缓冲队列上限（如 500 条，积压溢出淘汰最旧数据，准确统计 `droppedCount` 指标）；严格校验上游响应 `response.ok`，在遇到 5xx/429 或网络异常时未发送批次必须安全回退至队列头部，杜绝静默丢数据；基于连续失败次数引入有限指数退避重试（基础 1000ms，最大 30000ms），在退避窗口内拦截无效调用；导出过程挂载 `isFlushing` 飞行并发锁与 5s 网络超时中断，并在停机时提供排空契约。

### 12.5 Sentry 同源反代隧道与安全边界规范 (Sentry Tunnel & SSRF Defense)
- **严格权威主机白名单**：Sentry 同源转发隧道（`SentryTunnel.ts`）严禁使用 `host.includes("sentry")` 等模糊匹配。必须配置精确的官方权威摄取域名白名单（`*.ingest.sentry.io`、`*.ingest.us.sentry.io`、`*.ingest.de.sentry.io` 等）或显式配置的私有部署主机，彻底封堵 `sentry.evil.example` 等恶意 SSRF 攻击。
- **严格协议、默认端口与路径校验**：隧道仅放行 `https:` 协议与 443 默认端口，杜绝探测内网非常规端口与明文未加密连接；上游目标路径必须强校验合法的 Project ID 正则格式（`/^\/([0-9a-zA-Z_-]+)$/`），杜绝任意路径代理穿透。
- **载荷上限与错误脱敏**：隧道单次转发载荷严格限制为 256KB（超限快速返回 413），配置 5s fetch 超时中断与应用级滑动窗口限流；任何上游错误必须脱敏为通用安全响应（如 `502 Bad Gateway`），严禁向下游暴露内部网络拓扑与未处理异常堆栈。
- **上游网络失败识别必须全运行时收口**：隧道判定上游失败时**严禁**只匹配 Node 的旧文案（`fetch failed`、`ECONNREFUSED`、`ENOTFOUND` 等）。必须同时覆盖 Bun（`Unable to connect. Is the computer able to access the url?`）与 undici（`UND_ERR_*`）的文案与 errno 编号（含 `ConnectionRefused`、`FailedToOpenSocket` 等首字母大写形态），并逐层下钻 `error.cause` 链，因为上游失败常被逐层包装。网络抖动与超时必须降级为 `logger.warn` 并返回 502 / 504；只有真正未预期的内部异常才允许 `logger.error` 与 500，否则一次上游抖动就会伪造出内部故障告警。

### 12.6 状态持久化与自动保存阶段守卫规范 (Auto-Save Lifecycle & Phase Guards)
- **非对局配置保存遵循等待阶段守卫**：客户端配置自动保存 Hook（`useAutoSave`）在处理房间设置、题目选项等非对局状态时，必须遵循 `phase === "waiting"` 阶段守卫。
- **视口脱离与组件卸载保护**：当配置组件离开视口、失焦或发生组件卸载（unmount）刷新残余队列时，若当前对局已开始（如已进入出题、描述、猜歌、投票、结算等阶段），必须立即终止残余的静默写提交，严禁用卸载时遗留的历史旧表单快照覆盖对局进行中的服务端权威状态。

## 13. 测试驱动设计与可测试性架构规范 (Test-Driven Design & Testability Invariants)

代码的可测试性是系统设计优雅程度的试金石。严禁编写不可测、过度 Mock 或过度依赖内部细节的脆弱测试，坚决消灭“虚假高覆盖率”。

### 13.1 行为驱动设计与解除实现细节耦合 (Behavior-Driven Design & Decoupling)
- **UI 测试基于语义与无障碍契约断言**：UI 组件测试严禁断言特定 Tailwind 原子类名（如 `rounded`、`bg-muted`、`px-1.5`、`border-dashed` 等）或深层 DOM 节点层级（如 `element.parentElement`）。断言必须且只能绑定无障碍角色（`getByRole`、`getByLabelText`）、用户可见文本与核心数据契约。样式重构只要未破坏视觉功能与交互，测试必须始终绿灯。
- **端到端测试禁止脆弱的 Class 字符串比对**：Playwright E2E 测试中严禁提取两套页面/外壳的全部 class 属性进行严格字符串比对（`toEqual`）。外壳与通用布局的一致性验证必须通过核心 Landmark（`<header>`、`<main>`）、关键导航入口呈现及视口无横向溢出（`scrollWidth <= innerWidth`）等页面级几何与功能契约进行校验。
- **长连接与事件驱动 Store 测试提供安全分发门面**：测试长连接与全局 Store（如 `UseWhoIsFakerStore`）状态流转时，WebSocket 模拟驱动必须封装高层语义触发门面（如 `emitStatus`、`emitMessage`），严禁在用例中直接使用裸数组下标（如 `statusHandlers[0]()`、`messageHandlers[0]()`）进行盲调，杜绝监听次序微调引发的级联用例挂死。

### 13.2 依赖倒置与杜绝运行时全局污染 (Dependency Injection & Anti-Global Stubbing)
- **时钟与伪随机数必须支持构造器/参数注入**：所有涉及时间推移、退避重试、熔断冷却、抖动调度或超时过期的类与模块（如 `NeteaseMusicProvider`、`OtlpExporter`），严禁在内部写死 `Date.now()` 或 `Math.random()`。必须在构造选项中提供可选的 `now?: () => number` 与 `random?: { nextFloat?: () => number }` 注入槽位。测试中必须通过推进虚拟时钟（Virtual Clock）实现 0ms 异步竞态断言，杜绝依赖真实 `sleep` 造成的测试耗时膨胀与 Flakiness。
- **第三方 API 与网络服务测试杜绝真实时钟等待**：在测试第三方外部服务、网络重试、限流防抖或定时心跳时，严禁使用真实 `Bun.sleep(...)`、`setTimeout` 或硬编码毫秒等待。必须强制注入虚拟时钟或受控 Promise 门面；对网络伪造 IP（如网易云 `X-Real-IP`）等随机源，必须通过参数注入确定性伪随机数生成器，消除并发用例间的随机源污染与断言 Flakiness。
- **网络与外部 IO 驱动参数化解耦**：客户端监控、遥测上报与辅助通信函数（如 `reportTelemetry`），必须通过可选参数（`options?: { serverUrl?: string; fetcher?: typeof fetch }`）支持网络驱动注入。单测中优先通过入参传入受控的 mock 实例，严禁滥用 `vi.stubGlobal("fetch")` 污染全局 runtime，消除并发用例之间的全局上下文竞争隐患。

### 13.3 消除过度 Mock 与原生状态驱动 (Zustand Native State Drive & Anti-Over-Mocking)
- **禁止模块级粗暴拦截核心状态库**：组件单测中严禁使用 `vi.mock("@/stores/...")` 将全局状态库整体拦截替换为硬编码函数。必须使用 Zustand 原生提供的状态注入能力（如 `UseSonGuessrStore.setState(...)`）预置前置数据并重置状态，真实验证组件在真实状态派发下的渲染与动作分发行为。
- **杜绝“在 Mock 里重写被测系统”的反模式**：测试不得将所有外部与核心依赖全部 Mock 成复杂的假逻辑，使得测试沦为“自己证明自己通过”的无意义仪式。非 IO 的纯业务状态机必须全真运行。

### 13.4 拒绝裸异常断言与深层契约加固 (Explicit Exception & Code Assertions)
- **严禁无参裸 `toThrow()`**：所有同步与异步异常断言（如 `toThrow()`、`rejects.toThrow()`、`rejects.toMatchObject(...)`），严禁使用不带任何参数的裸断言。
- **必须校验业务错误码或精确错误描述**：异常断言必须明确校验抛出的核心业务错误码（如 `code: "ROUND_NOT_STARTED"`、`code: "INVALID_ROOM_ID"`、`code: "MUSIC_API_RATE_LIMITED"`）或核心提示词，杜绝代码发生未预期的 `TypeError`（如 `undefined.property`）却被裸 `toThrow()` 误判通过的恶劣假阳性漏洞。

### 13.5 杜绝镜像重复测试套件与死测试 (Zero Redundant Duplicate Suites)
- **清理重命名遗留的镜像单测**：模块重构、文件重命名或迁移后，必须立即清理历史重复遗留的测试用例文件（如由于大小写或拼写变更残留的同义测试），严禁代码库中长期共存两套逻辑完全重叠的双胞胎单测。
- **清理路由与全局入口的过载历史 Mock**：在顶层组件测试（如 `App.test.tsx`）中，严禁残留已被重构删除的历史废弃模块 Mock（如已被合并或废弃的上下文与页面引用），确保测试代码整洁精炼。

## 14. 外部依赖与出题链路性能铁律 (Upstream I/O Fan-out & Latency Invariants)
- **禁止无界串行回源**：任何遍历候选再逐个回源上游的循环（番剧候选、歌曲检索词、候选人歌曲）都必须同时具备**并发窗口**与**总调用预算**，严禁出现"N 个候选 × M 个检索词 × K 个结果"全串行的写法。实测此类写法会把单次出题拖到 60s 以上，直接撞穿客户端 10s 请求超时。
- **无依赖的回源必须并行**：同一层级、彼此无数据依赖的上游调用（如同一曲目的多个检索词）必须用 `Promise.all` 并发发起，等待时间应接近单次往返而非累加。
- **候选重试必须有上界**：自动出题挑选候选失败后的重试次数必须是显式常量并配不变量测试，缺省的 `while (pool.length > 0)` 等于把最坏延迟交给题库大小决定。
- **可在检索结果判定的过滤必须前置**：会员可见性、热度阈值等能由检索结果字段直接判定的条件，必须在回源前过滤，严禁先 `getSong` 再丢弃。
- **性能预算以常量形式导出并测试**：调用预算与候选上界等阈值一律定义为具名导出常量（如 `ANIME_SONG_LOOKUP_BUDGET`、`AUTO_ANIME_CANDIDATE_LIMIT`），并由不变量测试直接断言，防止后续改动悄悄放宽上限。
- **性能结论必须来自 Sentry 实测**：性能审查以 Sentry 的 `dataset=spans` 聚合（`p50/p75/p95(span.self_time)` + `count()`）为准，禁止凭代码直觉判断快慢；`transactions` 数据集在本项目可能为空，不要据此得出"没有性能数据"的结论。
