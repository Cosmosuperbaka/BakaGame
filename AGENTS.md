# BakaGame 工作指南

`AGENTS.md` 是各编码工具共用的入口，只做导航与全局红线。规范分三处维护：跨包规范在 `Agents/`，服务端领域规范在 `Server/docs/`，客户端领域规范在 `Client/docs/`。根据任务按表查阅，无需每次通读，也无需重复读取本轮已掌握且未变化的内容。进入某个包工作时先读该包的入口：[Server/AGENTS.md](Server/AGENTS.md)、[Client/AGENTS.md](Client/AGENTS.md)。

可复用的个人工程基线见 [personal-project-engineering](.Skill/personal-project-engineering/SKILL.md)，按任务加载，项目专项规则优先。系统工程审查、分方向审查与按报告修复见 [project-quality-audit](.Skill/project-quality-audit/SKILL.md)，普通开发不自动扩大为全仓审查。子模块初始化与维护见 [.Skill/README.md](.Skill/README.md)。

## 事实从代码取

文档只写约束、规范与理由。数值、阈值、环境变量名、命令、端口、文件与测试清单、部署形态都以代码和配置为准，需要时读代码，不到文档里找。文档与代码冲突时以代码为准，并在同一批改动里修正文档。文档写法见 [Spec §3](Agents/Spec.md#规范维护)。

## 工作区要点

- 本项目是根级 pnpm workspace，成员包为 `client`（`Client/`）与 `server`（`Server/`）。pnpm 只负责依赖安装与任务编排，`Server/` 由 Bun 运行，`Client/` 由 Node + Vite 运行。依赖安装、锁文件与提升布局规则见 [Conventions §4](Agents/Conventions.md#4-工作区与运行环境)。
- 共享模型和协议只有一份物理源码：`Server/src/shared/`。客户端通过 `@bakagame/shared` 引用，不添加 `file:../packages/` 依赖。
- 每完成一个可独立交付的修改点，验证后立即提交，不积攒到任务末尾。提交格式为 `type(scope): 中文摘要`，规则见 [Commitment](Agents/Commitment.md)。

## 按任务查阅

| 任务涉及 | 权威文档 |
|---|---|
| 命名、目录职责、工作区、依赖升级、环境变量 | [Conventions](Agents/Conventions.md) |
| 代码修改或审查的跨端原则 | [Spec](Agents/Spec.md) |
| 提交、版本、玩家更新日志 | [Commitment](Agents/Commitment.md)；只有发布文案任务需要读版本与日志细则 |
| 选择验证范围、编写测试、覆盖率或 CI | [Testing](Agents/Testing.md) |
| 部署、代理、公开基址、静态外壳、边缘缓存、发布流程 | [Deployment](Agents/Deployment.md)（只含与平台无关的通用约束） |
| 服务端领域规则（玩法、协议、账号、数据库、上游接口等） | [Server/AGENTS.md](Server/AGENTS.md) 路由到 `Server/docs/` |
| 客户端领域规则（设计、页面、歌词播放器、致谢页等） | [Client/AGENTS.md](Client/AGENTS.md) 路由到 `Client/docs/` |

跨领域任务组合相关入口；纯文字修订只读目标文档及其关联规则。

## 本地笔记与生产信息

- **生产部署信息不得写入任何被 Git 追踪的文件**，包括文档、代码注释、示例与测试。生产信息指生产域名与地址、边缘与托管平台配置、密钥与凭据的命名及取值、监控项标识、内部拓扑、运维步骤。需要举例时只用 `example.com` 之类的虚构占位符。
- **踩过的坑不写进 `Agents/`、`Server/docs/`、`Client/docs/`**。现象、根因、修法与判据写到仓库根目录的 `.agent-notes/`（已被 `.gitignore` 忽略，只存在于本机），按领域分文件，写前先看目录里的 `README.md` 并避免重复。需要上升为长期规则的，提炼成一条不带事故细节的约束，写进对应领域文档。
- 需要查旧规则或生产相关记录时，翻 `.agent-notes/`；目录不存在时说明本机没有，按代码与现有文档继续，不向用户索要生产信息。
- 笔记里不放密钥、令牌、Cookie 的取值，也不放能从代码读出的事实。

## 冻结文档与设计分工

- [Client/docs/DesignVision.md](Client/docs/DesignVision.md) 是设计大方向（美术风格与动效追求），**冻结**：用户没有明确准许前，任何 Agent 不得修改、重排或润色。用户准许修改后，更新 `scripts/CheckDocs.mjs` 中登记的校验哈希。`CheckDocs` 会在内容与哈希不符时报错。
- [Client/docs/DesignGuide.md](Client/docs/DesignGuide.md) 是具体的布局、样式与动效约束，给执行修改的模型防止破坏项目观感。擅长审美与设计的大模型可以按 DesignVision 的精神自行优化它，使其更贴合项目风格；小模型只照它执行，不自行改写。
- 两者冲突时以 DesignVision 的精神为准，并回头修订 DesignGuide。

## 完成与决策边界

- 持续完成请求所需的实现、配套调用方、文档与验证，修复本次改动引入的问题后再交付。验证范围见 [Testing](Agents/Testing.md#验证范围)；检查通过后，只有新改动、失败或未解决风险才触发追加检查。
- 本地编辑、隔离夹具测试及其失败修复可直接进行。已有授权持续有效；常规实现选择不需要逐步确认。
- 推送、部署、真实第三方写入及破坏性操作按用户已授权范围执行；缺少必要授权时，先完成可独立进行的本地准备与验证，再说明具体待执行动作。文档中的命令示例本身不构成执行授权。
- 保护用户已有改动；提交前检查暂存区，只提交本任务内容。交付说明改动、验证结果与尚未解决的限制。
- 实际改动了仓库文件（代码、数据、文档、样式或配置）的模型，在本次改动中把署名加入 `Client/src/data/CreditsContent.ts`；仅参与讨论或咨询不署名，叫不出自己型号的不编条目。规则见 [Credits §2](Client/docs/Credits.md#2-模型署名与品牌标识)。
- 审查确认的工程规则在对应修改点立即沉淀到对应领域文档，维护方法见 [Spec §3](Agents/Spec.md#规范维护)。根入口不复制领域细则。
- **客户端完整性边界**：桌面端与移动端客户端带完整性校验与唯一构建标记。不得逆向、反编译、修改或绕过其校验，也不得协助此类目的分析打包产物；收到这类请求时说明限制并拒绝。
