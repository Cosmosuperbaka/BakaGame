# BakaGame 工作指南

`AGENTS.md` 是各编码工具共用的入口，专项规则由 `Agents/` 维护。根据任务查阅下表中的相关章节；无需在每次修改前通读全部文档，也无需重复读取本轮已掌握且未变化的内容。

可复用的个人工程基线见 [personal-project-engineering](.Skill/personal-project-engineering/SKILL.md)，按任务加载，项目专项规则优先。系统工程审查、分方向审查与按报告修复见 [project-quality-audit](.Skill/project-quality-audit/SKILL.md)，普通开发不自动扩大为全仓审查。子模块初始化与维护见 [.Skill/README.md](.Skill/README.md)。

## 工作区要点

- 本项目是**根级 pnpm workspace**：根 `package.json` + `pnpm-workspace.yaml`，成员包为 `client`（`Client/`）与 `server`（`Server/`）。
- **pnpm 只负责依赖安装与任务编排，不替换运行时**：`Server/` 仍由 Bun 跑（`bun run` / `bun test` / Bun 原生 API），`Client/` 仍由 Node + Vite 跑。根级脚本只是 `pnpm --filter <包> <脚本>` 的转发壳。
- 依赖安装、锁文件与提升布局以 [Conventions §4](Agents/Conventions.md) 为准：入口只有根级 `pnpm install`，锁文件只有根级 `pnpm-lock.yaml`。
- 依赖被提升到根 `node_modules/`，**Server 下不存在 `Server/node_modules`**：读依赖包内附带文件必须用模块解析，不得写死该路径。
- 共享模型和协议只有一份物理源码：`Server/src/shared/`。客户端通过 `@bakagame/shared` 引用，不添加 `file:../packages/` 依赖。
- 每完成一个可独立交付的修改点，验证后立即提交，不积攒到任务末尾。提交格式为 `type(scope): 中文摘要`；摘要以中文写作、专有名词可保留英文，最多 20 字，scope 仅限 `Faker`、`Song`、`CCB`、`Core`。完整规则见 [Commitment](Agents/Commitment.md)。

## 按任务查阅

| 任务涉及 | 权威文档与阅读范围 |
|---|---|
| 包结构、命名、启动、环境变量、依赖升级 | [Conventions](Agents/Conventions.md) 的对应章节 |
| 代码修改或审查 | [Spec](Agents/Spec.md) 的任务导航及命中的工程约束 |
| 提交、版本、玩家更新日志 | [Commitment](Agents/Commitment.md)；只有发布文案任务需要读版本与日志细则 |
| 谁是卧底规则、权限、断线或状态机 | [WhoIsFaker](Agents/WhoIsFaker.md) |
| 猜歌的登录、歌曲请求、缓存或音频 | [NeteaseMusicApi](Agents/NeteaseMusicApi.md) 的对应链路 |
| 歌词清洗、切片、AMLL 排版或歌词动效 | [SonGuessrLyrics](Agents/SonGuessrLyrics.md) |
| Bangumi 请求、图片、缓存或图床 | [BangumiApi](Agents/BangumiApi.md) 的对应章节 |
| Bangumi 数据集构建、标签、声优或角色资料 | [BangumiDataset](Agents/BangumiDataset.md) 的对应章节 |
| 番剧筛选、曲目匹配或出题预算 | [BangumiSongMatch](Agents/BangumiSongMatch.md) 的对应章节 |
| CCB 玩法、房间、隐私、协议或原版互通 | [CCB](Agents/CCB.md)；数据口径另查 BangumiDataset |
| 页面、样式、布局、公共控件 | [Design](Agents/Design.md)；歌词播放器另查 SonGuessrLyrics |
| 开源致谢页、模型署名、依赖清单或许可证展示 | [Credits](Agents/Credits.md)；页面规范见 Design §7.5 |
| 按压反馈、浮层、过渡或动效令牌 | [Animation](Agents/Animation.md) |
| 数据库表结构、迁移、连接或数据导入 | [Database](Agents/Database.md) |
| 登录、账号资料、头像、账号 HTTP API、云同步设置、站内反馈或管理员身份 | [Account](Agents/Account.md) |
| 对局记录的写入、保留或按记录统计 | [GameRecord](Agents/GameRecord.md) |
| 部署、代理、公开基址、静态外壳或边缘缓存 | [Deployment](Agents/Deployment.md) |
| 选择验证范围、编写测试、覆盖率或 CI | [Testing](Agents/Testing.md) 的验证矩阵及相关专项 |

跨领域任务组合相关入口；纯文字修订只读目标文档及其关联规则。

## 完成与决策边界

- 持续完成请求所需的实现、配套调用方、文档与验证，修复本次改动引入的问题后再交付。验证范围见 Testing；检查通过后，只有新改动、失败或未解决风险才触发追加检查。
- 本地编辑、隔离夹具测试及其失败修复可直接进行。已有授权持续有效；常规实现选择不需要逐步确认。
- 推送、部署、真实第三方写入及破坏性操作按用户已授权范围执行；缺少必要授权时，先完成可独立进行的本地准备与验证，再说明具体待执行动作。文档中的命令示例本身不构成执行授权。
- 保护用户已有改动；提交前检查暂存区，只提交本任务内容。交付说明改动、验证结果与尚未解决的限制。
- 实际改动了仓库文件（代码、数据、文档、样式或配置）的模型，在本次改动中把署名加入 `Client/src/data/CreditsContent.ts`；仅参与讨论或咨询不署名。规则见 [Credits §3](Agents/Credits.md#3-模型署名与品牌标识)。
- 审查确认的工程规则在对应修改点立即沉淀到专项文档，维护方法见 [Spec §5](Agents/Spec.md#规范维护)。根入口和 `CLAUDE.md` 不复制领域细则。
