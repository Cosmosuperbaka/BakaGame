# BakaGame

基于 WebSocket 的实时多人派对游戏合集，包含两款游戏：

- **WhoIsFaker（谁是卧底）**：线上版"谁是卧底"。发言、投票、平票加赛、补充发言、夜间行动、白板猜词等完整流程；8 人以上可出现白板，10 人以上可出现天使；支持断线重连、聊天、观战与补位。
- **SongGuessr（听歌猜歌）**：接入网易云音乐，在线听片段竞猜歌曲。

所有游戏状态由服务端持有并经 WebSocket 推送，客户端不持有权威状态；服务端无数据库，房间状态全部在内存中。

## 目录结构

| 目录 | 说明 |
|---|---|
| `Server/` | 服务端，Bun + Elysia，房间管理与实时对局 |
| `Client/` | 客户端，React 19 + Vite + Zustand + Tailwind CSS |
| `Server/src/shared/` | 双端共用的模型与协议定义，客户端经 `@bakagame/shared` 别名引用 |
| `Agents/` | 工程文档：约束、设计、测试、部署、版本规范 |

## 快速开始

环境要求：[Bun](https://bun.sh)（服务端）、Node.js 与 npm（客户端）。

```bash
git clone https://github.com/Cosmosuperbaka/BakaGame.git
cd BakaGame

# 启动服务端，默认端口 4850
cd Server
cp .env.example .env
bun install
bun run dev

# 另开终端启动客户端
cd ../Client
cp .env.example .env
npm install
npm run dev   # http://localhost:5173
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
| `bun run docs:openapi` | 导出 OpenAPI 到 `Agents/http-openapi.json` |

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

房间 ID `Oblivionis`（大小写不敏感）为测试房间，规则与普通房间一致。页面内 TestController 可跳转阶段、设置角色、添加或移除机器人，所有操作均发送真实服务端命令。跳转到需要完整人数的阶段前，应先用机器人补满房间；对局中途加入的机器人会成为观战者。

## 生产部署

服务端必须部署在反向代理或边缘网关之后：TLS 终止、握手与请求限流、WebSocket 连接配额、消息大小与带宽限制、空闲与握手超时均由入口层负责，不得将 Bun 端口直接暴露公网。详细要求与容量基线见 [Agents/Deployment.md](Agents/Deployment.md)。

## 文档

| 文档 | 内容 |
|---|---|
| [Agents/Spec.md](Agents/Spec.md) | 工程开发约束 |
| [Agents/Design.md](Agents/Design.md) | 前端设计规范 |
| [Agents/Animation.md](Agents/Animation.md) | 动效设计规范 |
| [Agents/Testing.md](Agents/Testing.md) | 测试分层与验证流程 |
| [Agents/Deployment.md](Agents/Deployment.md) | 生产部署边界 |
| [Agents/versioning.md](Agents/versioning.md) | 版本号与提交规范 |

## 版本

用户可见版本号维护在 `Client/src/data/changelog.json`，取其中最大条目，规范见 [Agents/versioning.md](Agents/versioning.md)。

## 参与贡献

提交 Issue 请使用内置模板（Bug 报告 / 功能建议），标签分组与用法见 [.github/labels.md](.github/labels.md)。提交 PR 请填写内置模板，变更说明遵循 [Agents/versioning.md](Agents/versioning.md) 的 commit 规范，验证要求见 [Agents/Testing.md](Agents/Testing.md)。

## 许可证

[AGPL-3.0](LICENSE)
