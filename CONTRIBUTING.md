# 参与贡献

谢谢你愿意帮忙。不写代码也能贡献，先看你属于哪一条路。

## 玩家

**报 Bug**：用站内右上角的反馈入口，或者提 [Bug 报告](https://github.com/Cosmosuperbaka/BakaGame/issues/new?template=bug_report.yml)。写清在哪款游戏、做了什么、看到了什么就够了，看不懂的选项可以跳过。

**提想法**：用[功能建议](https://github.com/Cosmosuperbaka/BakaGame/issues/new?template=feature_request.yml)。说清哪里不方便，比直接给方案更有用。

**内容有问题**：用[内容问题](https://github.com/Cosmosuperbaka/BakaGame/issues/new?template=content_report.yml)。按内容来源，能做的事不一样：

| 内容 | 怎么处理 |
|---|---|
| 谁是卧底的词 | 词由出题人现场写，项目没有公共词库，所以不需要提交词表。 |
| 猜歌的歌单 | 歌单来自网易云音乐和 QQ 音乐，不用提交到仓库，房间自动出题时选你的歌单就能用。选歌或歌词出了问题再提 Issue，带上歌名。 |
| CEE 的角色资料 | 资料来自 Bangumi，条目本身有误请到 Bangumi 修改。标签或线索明显不对可以提 Issue，带上角色名。 |

## 开发者

### 环境

按 [README](README.md#开发者本地跑起来) 跑起来。工作区规则见 [Conventions](Agents/Conventions.md)：依赖只用根目录 `pnpm install` 安装，Server 由 Bun 运行，Client 由 Node 运行。

### 常用命令

在仓库根目录执行：

| 命令 | 作用 |
|---|---|
| `pnpm dev` | 同时启动服务端和客户端 |
| `pnpm check` | 两端类型检查 |
| `pnpm lint` | 两端 lint |
| `pnpm test` | 两端单元与集成测试 |
| `pnpm e2e` | 浏览器端到端测试 |
| `node scripts/CheckDocs.mjs` | 检查文档链接与引用 |

### 提交前

1. 涉及玩法规则或协议，建议先开 Issue 对齐方向。
2. 按 [Spec](Agents/Spec.md) 写代码。领域规则从 [AGENTS.md](AGENTS.md) 的导航表进入。
3. 按 [Testing](Agents/Testing.md#验证范围) 选择验证范围。修缺陷时附一条修复前会失败的回归测试。
4. 提交信息遵循 [Commitment](Agents/Commitment.md#提交信息)，格式是 `type(scope): 中文摘要`。
5. 用户可见的改动，更新日志由维护者发布时结算，PR 里写清楚变化就行。

### 不接受的改动

- 逆向、修改或绕过桌面与移动客户端的完整性校验。
- 把生产部署信息、密钥或真实账号写进仓库，规则见 [AGENTS.md](AGENTS.md)。
- 修改 `Client/docs/DesignVision.md`，这份文档由维护者决定。

参与本项目即表示你同意遵守[行为准则](CODE_OF_CONDUCT.md)，贡献内容按 [AGPL-3.0](LICENSE) 授权。
