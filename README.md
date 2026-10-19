# BakaGame

**在线体验**：<https://game.baka.website>

基于 WebSocket 的实时多人派对游戏合集，包含三款游戏：

- **WhoIsFaker（谁是卧底）**：线上版"谁是卧底"。发言、投票、平票加赛、补充发言、夜间行动、白板猜词等完整流程；8 人及以上可出现白板与天使；支持断线重连、聊天、观战与补位。
- **SonGuessr（听歌猜歌）**：联动网易云音乐与 QQ 音乐，在线听片段竞猜歌曲或 Bangumi 番剧。

- **CEE（二刺猿笑传之猜猜呗增强版）**：基于 Bangumi 角色资料的多人竞猜，支持本地房间与兼容原版的房间。

所有游戏状态由服务端持有并经 WebSocket 推送，客户端不持有权威状态；房间与对局状态保存在内存中。服务端另使用 SQLite 存储 Bangumi 曲目、角色资料及回填缓存；这些数据不是房间状态持久化。资料构建与部署要求见 [Server/docs/BangumiApi.md](Server/docs/BangumiApi.md) 和 [Server/docs/CEE.md](Server/docs/CEE.md)。

## 目录结构

| 目录 | 说明 |
|---|---|
| `Server/` | 服务端，Bun + Elysia，房间管理与实时对局 |
| `Client/` | 客户端，React 19 + Vite + Zustand + Tailwind CSS |
| `Server/src/shared/` | 双端共用的模型与协议定义，客户端经 `@bakagame/shared` 别名引用 |
| `Agents/` | 跨包工程规范：约定、测试、部署、提交与版本 |
| `Server/docs/`、`Client/docs/` | 各包的领域规范，由包内 `AGENTS.md` 路由 |

## 快速开始

环境要求：[Bun](https://bun.sh)（服务端）、Node.js 与 npm（客户端）。

```bash
git clone https://github.com/Cosmosuperbaka/BakaGame.git
cd BakaGame

# 启动服务端（端口与开关读 Server/.env.example）
cd Server
cp .env.example .env
# 按需修改 BANGUMI_API_URL（图片前缀固定走站内 /api/bangumi）
bun install
bun run dev

# 另开终端启动客户端
cd ../Client
cp .env.example .env
npm install
npm run dev   # 本地需把 VITE_SERVER_URL 指向开发后端
```

## 常用命令

### 服务端（`cd Server`）

| 命令 | 说明 |
|---|---|
| `bun run dev` | 开发模式（watch） |
| `bun run start` | 生产运行 |
| `bun run check` | TypeScript 类型检查 |
| `bun test` | 运行全部测试 |
| `bun run verify` | 类型检查 + 测试覆盖率 |
| `bun run docs:openapi` | 导出 OpenAPI 到 `Server/docs/http-openapi.json` |

### 客户端（`cd Client`）

| 命令 | 说明 |
|---|---|
| `npm run dev` | Vite 开发服务器 |
| `npm run build` | 类型检查 + 构建 |
| `npm run lint` | ESLint |
| `npm test` | Vitest 单元/集成/回归测试 |
| `npm run test:e2e` | Playwright 端到端测试，自动启动服务端与客户端 |
| `npm run verify` | lint + 覆盖率 + 构建 + E2E |

## 测试模式

房间 ID `Oblivionis`（大小写不敏感）为专用测试与调试房间。与受限的普通房间不同，该房间提供调试控制台（TestController），拥有自由跳转阶段、快速跳过倒计时、注入与移除测试人机、强制指派角色的调试控制能力，所有操作均发送真实服务端命令。跳转到需要完整人数的阶段前，应先用机器人补满房间；对局中途加入的机器人会成为观战者。

## 生产部署

服务端必须部署在反向代理或边缘网关之后：TLS 终止、握手与请求限流、WebSocket 连接配额、消息大小与带宽限制、空闲与握手超时均由入口层负责，不得将 Bun 端口直接暴露公网。详细要求与容量基线见 [Agents/Deployment.md](Agents/Deployment.md)。

## 文档

| 文档 | 内容 |
|---|---|
| [AGENTS.md](AGENTS.md) | Agent 统一引导总览与阅读顺序 |
| [Agents/Conventions.md](Agents/Conventions.md) | 命名、目录职责与工作区约定 |
| [Agents/Spec.md](Agents/Spec.md) | 跨端工程开发约束 |
| [Agents/Commitment.md](Agents/Commitment.md) | 提交、版本号与玩家更新日志规范 |
| [Agents/Testing.md](Agents/Testing.md) | 测试分层与验证流程 |
| [Agents/Deployment.md](Agents/Deployment.md) | 部署通用约束（代理、缓存、发布流程） |
| [Server/AGENTS.md](Server/AGENTS.md) | 服务端领域规范入口（`Server/docs/`） |
| [Client/AGENTS.md](Client/AGENTS.md) | 客户端领域规范入口（`Client/docs/`） |

## 版本

用户可见版本号维护在 `Client/src/data/changelog.json`，取其中最大条目，规范见 [Agents/Commitment.md](Agents/Commitment.md)。

## 参与贡献

提交 Issue 请使用内置模板（Bug 报告 / 功能建议），标签分组与用法见 [.github/labels.md](.github/labels.md)。提交 PR 请填写内置模板，变更说明遵循 [Agents/Commitment.md](Agents/Commitment.md) 的 commit 规范，验证要求见 [Agents/Testing.md](Agents/Testing.md)。

## 许可证

[AGPL-3.0](LICENSE)
