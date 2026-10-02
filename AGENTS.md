# BakaGame 工作指南

`AGENTS.md` 是各编码工具共用的入口，专项规则由 `Agents/` 维护。根据任务查阅下表中的相关章节；无需在每次修改前通读全部文档，也无需重复读取本轮已掌握且未变化的内容。

可复用的个人工程基线见 [personal-project-engineering](.Skill/personal-project-engineering/SKILL.md)，按任务加载，项目专项规则优先。子模块初始化与维护见 [.Skill/README.md](.Skill/README.md)。

## 工作区要点

- `Server/` 使用 Bun，`Client/` 使用 Node/npm；根目录没有 `package.json`。命令在对应包内执行。
- 共享模型和协议只有一份物理源码：`Server/src/shared/`。客户端通过 `@bakagame/shared` 引用，不添加 `file:../packages/` 依赖。
- 每完成一个可独立交付的修改点，验证后立即提交，不积攒到任务末尾。提交格式为 `type(scope): 中文摘要`；摘要纯中文、最多 12 字，scope 仅限 `Faker`、`Song`、`CCB`、`Core`。完整规则见 [Commitment](Agents/Commitment.md)。

## 按任务查阅

| 任务涉及 | 权威文档与阅读范围 |
|---|---|
| 包结构、命名、启动、环境变量、依赖升级 | [Conventions](Agents/Conventions.md) 的对应章节 |
| 代码修改或审查 | [Spec](Agents/Spec.md) 的任务导航及命中的工程约束 |
| 提交、版本、玩家更新日志 | [Commitment](Agents/Commitment.md)；只有发布文案任务需要读版本与日志细则 |
| 谁是卧底规则、权限、断线或状态机 | [WhoIsFaker](Agents/WhoIsFaker.md) |
| 猜歌的登录、歌曲请求、缓存或音频 | [NeteaseMusicApi](Agents/NeteaseMusicApi.md) 的对应链路 |
| 歌词清洗、切片、AMLL 排版或歌词动效 | [SonGuessrLyrics](Agents/SonGuessrLyrics.md) |
| Bangumi 请求、图片、曲目筛选、SQLite 数据构建或角色资料 | [BangumiApi](Agents/BangumiApi.md) 的对应章节 |
| CCB 玩法、房间、隐私、协议或原版互通 | [CCB](Agents/CCB.md)；数据口径另查 BangumiApi |
| 页面、样式、布局、公共控件 | [Design](Agents/Design.md)；歌词播放器另查 SonGuessrLyrics |
| 按压反馈、浮层、过渡或动效令牌 | [Animation](Agents/Animation.md) |
| 部署、代理、公开基址、静态外壳或边缘缓存 | [Deployment](Agents/Deployment.md) |
| 选择验证范围、编写测试、覆盖率或 CI | [Testing](Agents/Testing.md) 的验证矩阵及相关专项 |

跨领域任务组合相关入口；纯文字修订只读目标文档及其关联规则。

## 完成与决策边界

- 持续完成请求所需的实现、配套调用方、文档与验证，修复本次改动引入的问题后再交付。验证范围见 Testing；检查通过后，只有新改动、失败或未解决风险才触发追加检查。
- 本地编辑、隔离夹具测试及其失败修复可直接进行。已有授权持续有效；常规实现选择不需要逐步确认。
- 推送、部署、真实第三方写入及破坏性操作按用户已授权范围执行；缺少必要授权时，先完成可独立进行的本地准备与验证，再说明具体待执行动作。文档中的命令示例本身不构成执行授权。
- 保护用户已有改动；提交前检查暂存区，只提交本任务内容。交付说明改动、验证结果与尚未解决的限制。
- 审查确认的工程规则在对应修改点立即沉淀到专项文档，维护方法见 [Spec §5](Agents/Spec.md#规范维护)。根入口和 `CLAUDE.md` 不复制领域细则。
