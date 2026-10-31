# Server 工作指南

服务端（Bun + Elysia）的领域规范放在 [docs/](docs/)。跨包原则、命名、验证与提交规则见根 [AGENTS.md](../AGENTS.md)。事实以代码为准，文档只写约束；生产信息与踩坑记录不写进文档，见根 AGENTS.md「本地笔记与生产信息」。

按任务读取，不必通读：

| 任务涉及 | 文档 |
|---|---|
| 实时同步、传输层、日志与遥测、探针、停机、HTTP 契约、出口安全 | [Engineering](docs/Engineering.md) |
| 谁是卧底规则、权限、断线或状态机 | [WhoIsFaker](docs/WhoIsFaker.md) |
| 猜歌的登录、歌曲请求、缓存或音频 | [NeteaseMusicApi](docs/NeteaseMusicApi.md) |
| 歌词清洗、切片或出题 | [SonGuessrLyrics](docs/SonGuessrLyrics.md) |
| Bangumi 请求、图片、缓存或图床 | [BangumiApi](docs/BangumiApi.md) |
| Bangumi 数据集构建、标签、声优或角色资料 | [BangumiDataset](docs/BangumiDataset.md) |
| 番剧筛选、曲目匹配或出题预算 | [BangumiSongMatch](docs/BangumiSongMatch.md) |
| CEE 玩法、房间、隐私、协议或原版互通 | [CEE](docs/CEE.md)；数据口径另查 BangumiDataset |
| CEE 排位赛的赛制、评分、难度档、人机、匹配或审计记录 | [CEERanked](docs/CEERanked.md) |
| 桌面 / 移动客户端通道证明、完整性自检、强制更新 | [ClientChannel](docs/ClientChannel.md) |
| 登录、账号资料、头像、账号 HTTP API、云同步、站内反馈、管理员 | [Account](docs/Account.md) |
| 数据库表结构、迁移、连接或数据导入 | [Database](docs/Database.md) |
| 对局记录的写入、保留或统计 | [GameRecord](docs/GameRecord.md) |

部署、代理与发布流程见根 [Deployment](../Agents/Deployment.md)，测试范围见 [Testing](../Agents/Testing.md)。
