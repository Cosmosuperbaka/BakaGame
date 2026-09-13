# 生产部署边界

WhoIsFaker 与 Songuessr 的实时业务分别通过 `/api/whoisfaker/ws` 和
`/api/songuessr/ws` 提供。应用服务负责 WebSocket
协议解析、业务权限和房间状态，不在进程内按来源 IP 实现限流或连接配额。

## 反向代理职责

生产环境必须在公开入口的反向代理或边缘网关配置以下保护：

- 终止 TLS，并只向公网暴露 HTTPS/WSS。
- 限制单个来源的握手速率、请求速率和并发 WebSocket 连接数。
- 限制 HTTP 请求体、WebSocket 消息或帧大小以及连接带宽。
- 配置空闲连接和握手超时，同时允许正常对局使用长连接。
- 正确转发 WebSocket 的 `Upgrade` 与 `Connection` 头。
- 不得在代理层注入或强制启用 `permessage-deflate`；应用当前为兼容 iOS WebKit 全局关闭该扩展。
- 只把受信任的前端来源转发给服务；应用的 `CLIENT_URL` 必须与该来源一致。

具体数值应按部署平台容量和真实流量确定，并由平台监控验证。没有完成上述入口保护时，
不得把 Bun 服务端口直接暴露到公网。

## 应用职责

应用仍必须校验每个命令的结构、身份、权限、阶段和业务数据。代理层的资源保护不能替代
`Server/src/transport/WhoIsFakerProtocol.ts` 与 `WhoIsFakerService`（及 `SonGuessrService`）的业务校验；应用校验也不能替代代理层的
来源限流和资源配额。

听歌猜番还需要在服务端配置 `BANGUMI_API_URL` 和可选的 `BANGUMI_IMAGE_URL`。这两个地址
只允许由服务端访问；客户端不得直连 Bangumi，代理也不得把 `lain.bgm.tv` 原始图片地址暴露
给浏览器。发布前应验证镜像支持 `/v0/search/subjects` 与 `/v0/subjects/{id}`，并确认图片
镜像保留原始路径、查询参数和片段。

## 带宽与容量基线

实时状态采用带修订号的增量同步，首次连接、重连、修订缺口和周期校准才发送全量。
生产发布前必须运行 `bun test test/NetworkCapacity.test.ts`；其固定验收目标是单台
6 Mbps 出口承载 150 名 WhoIsFaker 玩家，并在每秒 12 次房间变化与每分钟一次全量校准下
保留 15% 的 TLS/TCP/IP 传输余量。代理的带宽监控应按应用出口持续核对这一预算；超过预算时
优先检查新增快照字段、重复事件和广播频率，不得通过取消最终同步或延长到不可接受的状态延迟来过测。

## 持续部署流水线 (Continuous Deployment)

后端采用 GitHub Actions 自动化部署流水线（`.github/workflows/deploy.yml`），在代码推送至 `main` 分支且包含 `Server/**` 目录变更时，或通过 `workflow_dispatch` 手动触发时自动更新服务器。仅客户端或非服务端文件（如 `Client/`、`Agents/`、文档等）变更时不会触发后端部署。

### 流水线架构与流程

1. **前置质量门禁 (`verify`)**：
   - 在 GitHub Actions 托管 runner (`ubuntu-latest`) 中安装 Bun 环境并执行 `bun install`。
   - 运行严格 TypeScript 类型检查 (`bun run check`) 与全量测试套件 (`bun test`)。
   - 任何类型错误或单测失败立即阻断流水线，绝不向生产环境推送未验证的代码。
2. **远程安全连接 (`deploy`)**：
   - 通过 `appleboy/ssh-action` 建立至生产服务器的 SSH 会话，严格启用 `script_stop: true`。
   - `command_timeout: 3m`，且 `deploy` 作业设 `timeout-minutes: 3` 作为硬兜底：生产部署不允许长时间挂起。
3. **代码对齐与容器重启**：
   - 切换至 `/BakaGame` 仓库目录。
   - 执行 `git fetch origin main && git reset --hard origin/main` 对齐生产分支。
   - 执行 `sudo docker restart BakaGame` 热重启后端容器。容器启动入口自带依赖安装与环境初始化逻辑，每次启动时自动完成容器内部服务端依赖的同步与服务拉起。
4. **就绪探测与健康检查**：
   - 轮询 `http://127.0.0.1:4850/health` 端点（最多重试 15 次，每次间隔 2 秒）。
   - 验证响应中包含 `{"status":"ok"}`。
   - 若 30 秒内未能就绪，自动打印 `sudo docker logs --tail 50 BakaGame` 并退出报错，便于在 Actions 界面快速定位崩溃日志。

### 时间预算铁律

生产服务器位于中国大陆，出境链路质量不可控。`deploy` 作业的每一段都必须落在预算内，
**任何新的部署步骤都要先声明它占用的秒数**，否则不得合入：

| 阶段 | 预算 |
|---|---|
| runner 准备 + SSH 建连 | ≤ 15s |
| `git fetch` + `reset` + 数据库校验 | ≤ 10s |
| 节点测速 | ≤ 7s |
| 数据下载（仅数据变更时才发生） | ≤ 105s（脚本内 `DL_DEADLINE` 绝对截止） |
| 容器重启 | ≤ 5s |
| 健康检查 | ≤ 30s |

合计上限约 172s，仍留 8s 余量给 3 分钟硬超时。**常态部署（数据未变）应在 60s 内完成**，
这是目标值而非上限：数据下载路径必须设计成"无事发生"。

### Git LFS 大文件获取约束（中国大陆服务器）

`Server/data/bangumi-*.sqlite` 由 Git LFS 托管（合计约 200MB），是本流水线唯一的重资产。
在大陆服务器上，**任何"顺手 `git lfs pull`"的写法都是不可接受的**，原因与对策如下：

- **LFS 镜像前缀对实体下载无效**。把 `remote.origin.lfsurl` 改成
  `https://<代理>/https://github.com/<repo>.git/info/lfs` 只能让体积微小的 batch
  小请求走代理；batch 响应里的 `href` 由 GitHub 返回，指向
  `github-cloud.githubusercontent.com/alambic/media/...` 这类签名直链，git-lfs 会
  **直连**它。也就是说代理只加速了几百字节的元数据，200MB 实体依旧是裸奔出境。
  排查时必须同时看"镜像是否生效"与"实体字节从哪个域名下来"，只看前者会误判。
- **实体下载必须走 `raw` 形态的通用代理**：
  `https://<节点>/https://github.com/<repo>/raw/<ref>/<path>`。该形态下代理在服务端
  跟随 GitHub 到 `media.githubusercontent.com` 的 302，返回的是真实字节而非 LFS
  指针文本。**不要用 `media.githubusercontent.com` 直接拼前缀**：多数代理白名单里
  没有这个域名，会直接 403。节点清单维护在
  [https://github.akams.cn/](https://github.akams.cn/)，脚本内置多个节点并在每次部署
  时并行测速选最快者，单点失效不影响整体。
- **测速探针必须校验内容而不是只看速度**。403/404 错误页体积小、`speed_download`
  虚高，极易被误选成"最快节点"。只有响应体前 15 字节等于 `SQLite format 3` 的节点
  才计入有效测速结果。
- **禁止 smudge，实体文件由脚本接管**。部署脚本先 `export GIT_LFS_SKIP_SMUDGE=1`，
  再把已就位的库文件挪到 `<仓库>/.deploy-stash`，`git reset --hard` 后按 LFS OID
  比对：OID 未变则原子 `mv` 回位，**零网络**；OID 变化才下载。这是达成 1 分钟部署的
  核心机制——数据一周才更新一次，九成以上的部署不该产生任何大文件流量。
- **校验以 sha256 对齐 LFS OID 为唯一标准**。文件大小、SQLite 魔数、`sha256sum ==
  oid` 三者都通过才算成功，缺一不可。
- **失败必须回滚且不重启容器**。脚本用 `trap ... EXIT` 在非零退出时把旧库文件放回
  原位，避免把指针文本留在工作区、让下一次容器重启直接读到坏数据；同时失败路径
  不执行 `docker restart`，线上服务保持原状。
- **并发临时路径不能用 `$$` 命名**。两个库文件是并行下载的，而 bash 的 `$$` 在子
  shell 中仍是父进程 PID，用它拼临时目录会让两个任务互相覆盖，最终产出体积正确但
  内容错乱的文件。临时路径必须由文件名派生。

### GitHub Secrets 密钥配置规范

严禁将真实服务器凭据提交至代码库。部署依赖以下 GitHub Repository Secrets：

| Secret 名称 | 说明 | 示例/默认值 |
|---|---|---|
| `DEPLOY_HOST` | 生产服务器 IP 地址或域名 | 必填 |
| `DEPLOY_PORT` | SSH 端口号（非标端口） | `5438`（未设置时默认 `22`） |
| `DEPLOY_USER` | SSH 登录用户名 | `ubuntu`（未设置时默认 `ubuntu`） |
| `DEPLOY_KEY` | 用于 SSH 鉴权的私钥纯文本 | 必填（完整包含 BEGIN/END 标记） |
| `DEPLOY_PASSPHRASE` | 用于解密 SSH 私钥的密码（若私钥受密码保护） | 可选（私钥无密码保护时无需配置） |
