# Client 工作指南

客户端（React + Vite）的领域规范放在 [docs/](docs/)。跨包原则、命名、验证与提交规则见根 [AGENTS.md](../AGENTS.md)。事实以代码为准，文档只写约束；生产信息与踩坑记录不写进文档，见根 AGENTS.md「本地笔记与生产信息」。

按任务读取，不必通读：

| 任务涉及 | 文档 |
|---|---|
| 页面架构、房间接入、状态派生、自动保存、前端遥测 | [Engineering](docs/Engineering.md) |
| 页面、样式、布局、公共控件、按压反馈、浮层、过渡、动效 | [DesignGuide](docs/DesignGuide.md)（全局视觉与动效原则，具体实现以代码为准）；美术方向冲突时看冻结的 [DesignVision](docs/DesignVision.md)（不得修改） |
| 歌词播放器（AMLL 排版、歌词动效） | [LyricPlayer](docs/LyricPlayer.md)；服务端清洗与切片另查 [SonGuessrLyrics](../Server/docs/SonGuessrLyrics.md) |
| CEE 页面与会话 | [CEE](docs/CEE.md)；服务端规则另查 [Server CEE](../Server/docs/CEE.md) |
| 开源致谢页、模型署名、依赖清单或许可证展示 | [Credits](docs/Credits.md) |

测试与截图范围见根 [Testing](../Agents/Testing.md)，部署与静态外壳见 [Deployment](../Agents/Deployment.md)。
