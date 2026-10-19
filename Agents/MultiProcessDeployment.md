# 后端多进程分片：生产部署待变更清单

**状态：未实施。** 代码侧只落地了运行时指标的分系列改造（见第 6 节），分片本身的容器、边缘与发布流水线改动**一项都没有执行**，也**没有推送**。
本文是给运维的变更清单与验收口径，不是部署授权；文中命令只在获得明确授权后执行。

实时平面为什么不能随便多开进程、以及能多开到几份，全部由压测报告决定。每条结论后面标了来源文件名，
报告在 `Server/tasks/loadtest/`（gitignore，不入库，重跑用 `bun run scripts/loadtest/Harness.ts`）。

## 1. 分片单元只能是「一款游戏一个进程」

- 房间、连接、大厅全部活在进程内存里，一个 Bun 进程只有一个事件循环，实测单进程在 `event-loop` 维度饱和时
  恰好吃掉 1 核（生产 `P-s1-p24`：972.52 cmd/s、`targetCores` 0.97）。多进程是唯一能把第二核用起来的路径。
- **握手不带房间号**：三款游戏的 WS 路径是固定的 `/api/whoisfaker/ws`、`/api/songuessr/ws`、`/api/cee/ws`，
  客户端从不提供 `handshakeQuery`，边缘因此只能按 URL 路径分流，做不到按房间一致性哈希。
- 于是同一款游戏开两个进程必然是错的：房间只存在于其中一个进程，另一个进程收到「加入某房间」只会回房间不存在；
  大厅列表（`lobby.subscribeRooms` / `song.lobby.subscribeRooms` / `cee.lobby.subscribeRooms`）各说各话；
  `CEERoomDirectory.allocate` 的四位号段在两个进程里独立分配，开局会跨进程撞号。
- 按游戏分片则天然规避撞号：一个号段只被一个进程使用。**前提是边缘真的按路径把三款游戏分开了**——
  每个进程都注册全部三条 WS 路由，所以「进程能应答 `/api/cee/ws`」并不证明分流生效（第 8 节）。

### 实测收益上界

本机 `local-9950x3d`，同口径 `mix faker=34,song=33,cee=33`、`pace 24`、单进程钉 `--target-cpuset`：

| 进程数 | cmd/s | 相对单进程 | targetCores | 饱和维度 | 报告文件 |
|---|---|---|---|---|---|
| 1 | 1283.15 | 1.00× | 1.04 | ack-latency | `X5-s1-p24-ramp-*.json` |
| 2 | 2477.66 | **1.93×** | 2.00 | ack-latency | `X5-s2-p24-ramp-*.json` |
| 4 | 5423.70 | 4.23× | 3.32 | ack-latency | `X5-s4-p24-ramp-*.json` |
| 8 | 8614.69 | 6.71× | 7.58 | event-loop | `X5-s8-p24-ramp-*.json` |

生产机 `sh2` 只有 2 vCPU（`nproc` = 2），所以**分片的天花板就是 ~1.9×，且这是别的机器上的数字**。
生产侧唯一的两进程读数是 `prod/P-s2-p24-ramp-*.json`（1056.36 cmd/s），但那一轮生成器、两个被测进程同挤
那两核（`--maxWorkers 1`、`targetCpuset`/`workerCpuset` 都没钉），只能读作「多开没把服务压垮」，
**不能读作加速比**。分片在生产上的真实收益目前是**未测得的**。

带宽不是约束（这是 `6 Mbps` 早期目标作废后的重新核算）：

| 节奏 | 人均带宽 | 生产单进程峰值 | 200 Mbps 折算 |
|---|---|---|---|
| `pace 24`（极限） | 0.12 Mbps（124.183 / 1036） | 1036 人、0.97 核 | ~1660 人 |
| `pace 4` | 0.025 Mbps（53.239 / 2092） | 2092 人、0.59 核（未饱和） | ~8000 人 |
| `pace 1`（真人） | 0.006 Mbps（37.629 / 6072） | 6072 人、0.57 核（`max-steps` 截断，未饱和） | 远大于 CPU 上限 |

结论：任何节奏下都是 **CPU 先饱和，200 Mbps 带宽用不满**。分片是为 CPU 服务的，别拿带宽当动机。

内存不是约束：`docker stats` 实测单容器 298.3 MiB，`free -m` 显示 available 2445 MB，
2~3 个进程放得下。因此**不需要**按游戏开关服务的 `SERVE_GAMES` 之类门控——每个进程照常装配三款游戏，
只是边缘只把其中一路的流量给它。

## 2. 真正的阻塞项：数据集是多进程共享的单一可写文件

当前容器（`docker inspect BakaGame`）的挂载决定了分片难度：

| 挂载 | 含义 |
|---|---|
| `/BakaGame/Server:/app:rw` | 代码、`node_modules`、`Server/data`、`Server/storage`、`Server/build` **全是同一份** |
| `/opt/1panel/runtime/node/BakaGame/.env:/.env:rw` | 环境变量一份，`run.sh` 里 `source /.env` |
| `/opt/1panel/runtime/node/BakaGame/run.sh:/run.sh:rw` | 入口脚本一份，容器 `Cmd` = `bash /run.sh` |

于是多个容器会同时打开同一批 SQLite：`bangumi.sqlite` 289 MB、`bangumi-character.sqlite` 251 MB、
`bangumi-song.sqlite` 85 MB、`storage/bangumi-enrichment.sqlite` 8 MB（`du -sh` 实测；`data/images` 3.1 GB）。
而 [OpenDataset.ts:18](../Server/src/infrastructure/OpenDataset.ts#L18) 的注释把前提写得很清楚——
**可写、不开 WAL、只靠 `busy_timeout = 5000`**，安全理由是「猜歌与 CEE 各持一个连接，但同处一个 Worker 线程、访问天然串行」。
分片直接打破这个前提：跨进程并发写会拿到最长 5 秒的 `SQLITE_BUSY` 等待（卡的是查询出题的那条路），
每日备份 `bangumi.sqlite.backup`（260 MB）与更新器落库会互相踩。

更要命的是**路径改不了**：`bangumiDbPath` 在 [Env.ts:377](../Server/src/config/Env.ts#L377) 写死为
`Server/data/bangumi.sqlite`，没有环境变量出口（对比 `BANGUMI_ENRICHMENT_PATH`、`BANGUMI_IMAGES_DIR` 都可覆盖）。
所以「只靠 env 把两个进程指向两份库」做不到。三条出路：

| 方案 | 做法 | 代价 |
|---|---|---|
| A 副本 | 每片加一层 `-v /BakaGame/shard-<game>/data:/app/data:rw` 覆盖到独立副本 | 磁盘 +~630 MB/片（`df` 现有 24 G 可用，够）；副本会随主库更新而**滞后**，需要一条运维同步步骤；部署脚本第 3 步的库校验只覆盖主路径，副本要另写 |
| B 代码改动 | 加 `BANGUMI_DB_PATH` 让路径可配，并给非写者一片**只读**打开模式 | 改动小且一次性，但必须先发版；只读 + 无 WAL 下，写者提交期间读者仍可能等到 `busy_timeout`，需要实测 |
| C 不分片 | 维持单进程，等有 ≥4 vCPU 的机器再做 | 放弃 ~1.9× |

**未选定方案前，不得把第二个容器接进边缘。** 单写者规则也顺带说明白：`BANGUMI_UPDATER_ENABLED=true`
只允许出现在一个容器（默认值只在 `DEPLOYMENT_ENVIRONMENT=production` 时为真，见 [Env.ts:380](../Server/src/config/Env.ts#L380)），
否则每个进程都按自己的节奏打上游、重复刷标签、重复落图，上游速率限制等于失效。

`RUN_INSTALL` / 依赖安装同理：`/app` 是同一份 `node_modules`，两个容器同时 `npm install` 会互相踩。
要么只在主容器装，要么都设 `RUN_INSTALL=0`、由发布流程在重启前装一次。

## 3. 边缘：要改的是这一个文件的那一个 location

实况（`cat /opt/1panel/www/conf.d/gameserver.baka.website.conf`）：`server_name gameserver.baka.website game.baka.website`，
`location /` 整段 `proxy_pass http://127.0.0.1:4850`，头里已经有 `proxy_http_version 1.1`、
`Upgrade $http_upgrade`、`Connection upgrade`、`X-Real-IP $remote_addr`。容器侧只把 4850 发布到宿主回环
（`Ports` = `127.0.0.1:4850->4850/tcp`），源站不直连公网，符合 [Deployment.md](Deployment.md#回源身份成立的前提源站不得被直连) 的口径。

改法：在 `location /` **之前**插入三条精确路径，`location /` 继续兜底给主片。

```nginx
# 三款游戏各自一个进程：容器内仍监听 4850（各自的网络命名空间），只在宿主发布口区分。
# 这样 .env 与 SERVER_PORT 都不用动，代价是宿主上多两个回环端口。
location ^~ /api/cee/ws {
    proxy_pass http://127.0.0.1:4851;
    # 下面这组头必须逐条照抄原 location：X-Real-IP 是 ClientIp.ts 的分桶契约，漏一条该路流量就整体退回 peer 桶。
    proxy_http_version 1.1;
    proxy_set_header Host $host;
    proxy_set_header X-Real-IP $remote_addr;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Host $server_name;
    proxy_set_header X-Forwarded-Proto $scheme;
    proxy_set_header Upgrade $http_upgrade;
    proxy_set_header Connection upgrade;
}
location ^~ /api/songuessr/ws { proxy_pass http://127.0.0.1:4852; # 同一组头
}
location ^~ /api/whoisfaker/ws { proxy_pass http://127.0.0.1:4850; # 同一组头
}
```

三条注意：

- **HTTP 与账号接口不要分片**：Better Auth、oRPC、图床、头像、遥测全部留在主片（`location /`）。
  `BETTER_AUTH_SECRET` 与 `SERVER_URL` 各容器共用同一份 `.env`，会话跨片仍然有效。
- 新 location 里**不要缩短读超时**：现有配置没写 `proxy_read_timeout`，走 nginx 默认 60 s，而应用侧
  没有任何 WS ping/pong（全仓无 `sendPing`/心跳帧）。空闲连接本来就会被切，客户端靠重连兜底。
  这是既有行为，不属于本次变更；要改就单独提，别混在分片这一批里。
- 边缘分流只能用真实链路证明，不能用 `curl` 证明（理由见 [Deployment.md](Deployment.md#探针与完成条件)）。

## 4. 发布流水线要改的点

`.github/workflows/deploy.yml` 现在把「一个容器」当成不变量，逐处列出来：

| 现在的步骤 | 分片后必须改成 |
|---|---|
| `sudo docker restart BakaGame` | 逐容器重启。**2 vCPU 只有两个进程位，做不到 start-new-then-stop-old**，只能逐片 `restart`，期间那一款游戏不可用几秒 |
| `docker exec -i BakaGame … DeploymentNotify.ts` | 对**每个容器各跑一次**。脚本默认打 `http://127.0.0.1:4850`，而 `docker exec` 打的是自己命名空间的回环，所以脚本不用改（[DeploymentNotify.ts:4](../Server/scripts/DeploymentNotify.ts#L4)）；漏跑任何一片，那一片的玩家收不到停机广播。`notify-shutdown` 只 `notifyShutdown()` 本进程的三个 service，并且会把**本进程**标记为停机（`/readyz` 转 503） |
| 排空 `sleep 3` | 每片各 3 秒。顺序必须是「该片通知 → 该片排空 → 该片重启」，**不要先把所有片都通知完再逐个重启**：先被通知的片会在整个窗口里保持 readiness 503 |
| `docker exec -i BakaGame … DeploymentProbe.ts` | 每片各跑一次（同一份脚本、同一个 4850 默认值即可）。注意它同时打三条 WS 订阅 ACK，而每片都注册全部路由，**探针全绿不代表边缘分流正确** |
| `mkdir Server/build` + `release.json` 原子写 | 无需改：`/app` 是同一份挂载，各容器读到同一 revision |
| 环境自查 `docker inspect BakaGame` 计数 11 | 逐容器各数一次，新容器必须给出同一个 11 |
| 时间预算（`timeout-minutes: 3`） | 现在是 1×(notify+3s+restart+probe)，分片后是 N×。**每一片新增的这一段都要先声明占用秒数**（[Deployment.md 时间预算铁律](Deployment.md#时间预算铁律)）。两片都跑满 30 秒探针预算会直接顶爆硬超时，实操上要把探针预算压到 ≤10 s 或两片探针并行 |
| `concurrency: deploy-production` | 不改，仍然全局串行 |
| 失败边界 | 不改：重启后验收失败不自动二次重启、不回滚，由运维按日志与获验 SHA 处理。分片后要多说一句：**已经重启成功的前几片不会回滚**，会停在混合版本状态 |

## 5. 限流额度会从「进程内」变成「全站 ×N」

`WsHandshakeQuota` 在 [App.ts:592](../Server/src/transport/App.ts#L592) 按进程构造（默认口径见
[Deployment.md](Deployment.md#反向代理职责)：单地址 64 条在途、每分钟 120 次新建、全局每分钟 3000 次）。
分片后**全局每分钟 3000 变成 3000×N**，等于悄悄放宽了握手保护；要按片数折算，或者干脆把这道兜底交给边缘，
并把应用侧全局额度调回原值。同一件事适用于所有进程内的滑动窗口桶：遥测三层桶、Sentry 隧道、
账号入口、CEE 聊天限流。这些都不跨进程共享，也没有 Redis 可用（实时平面按设计不引入外部状态）。

## 6. 可观测性：不改面板就会骗人

**这是本次唯一落地的代码改动**：[Index.ts:98](../Server/src/Index.ts#L98) 的 `reportRuntimeMetrics()` 从「进程内求和」
改成按游戏分系列上报（`bakagame.players.online` / `rooms.active` / `connections.active`，带 `{ game }` 标签）。
原因正是分片：同名 gauge 不带标签时会被后上报的进程**覆盖**成局部值，全站在线数凭空少一半。
已用 `bun run check` 通过类型检查并按 prettier 格式化；**未跑真实上报**（需要线上 DSN 与 OTLP 出口）。

随之而来的运维口径变化：

- 面板与告警必须**跨系列求和**。任何仍按裸指标名读的图，现在读到的是最后一个上报进程的局部值。
- `/health`、`/readyz`、`/livez`、后台概览都是**进程内**的：`/health` 只报该片的房间/连接/在线
  （[System.ts:240](../Server/src/transport/routes/System.ts#L240) 聚合的是本进程的三个 service）。
  全站口径要么逐端口求和，要么接受局部读数；`/health` 的匿名量级近似（`coarse`）逻辑不变。
- `/readyz` 逐容器 503 才是滚动摘流需要的行为，这条是分片的正向收益。
- Sentry 心跳：每个进程都往**同一个** monitor slug `bakagame-server-heartbeat`
  （[Sentry.ts:122](../Server/src/infrastructure/Sentry.ts#L122)）每 60 秒 check-in。一片挂了，其余片会持续把它报成 OK，
  **漏报是默认结果**。要么给每片一个独立 slug（需要 Sentry 侧先建 monitor），要么改用带标签的 gauge 做在线数告警兜底。
- `OTEL_SERVICE_NAME` 各片相同（共用 `.env`）时 span 无法区分来源；分片上线那批要顺带覆盖它。

## 7. 统计与业务数据：实测下来反而安全

- 站点访问统计跨片仍然准确：访客键是 `(北京时间日, HMAC(密钥, 日+访客ID))`，落库是
  `onDuplicateKeyUpdate { views: views + values(views) }`（[SiteStatsRepository.ts:62](../Server/src/infrastructure/db/SiteStatsRepository.ts#L62)）。
  同一访客被两片各记一次只多算 PV，UV 行仍然唯一。`purge()` 各片都跑，幂等，只是多做几遍。
- 对局记录、账号、云同步、反馈都写 MySQL/TiDB，本来就跨进程；不需要改动。
- 反作弊复核队列交的是同一个库对象（`AntiCheatReviewRepository`），也不依赖进程内状态。
- CEE 原版互通（`CCB_ORIGINAL_SERVER_URL`）走的是外部服务端，与会话同进程；分片后原版流量必须整体跟着
  那一款游戏走，不要在两片之间混。

## 8. 上线前必须补的验证（当前一条都没有）

代码侧只做到「类型检查通过 + 指标改成带标签上报」。下面这些**全部未验证**，缺任何一条都不许把第二片接进边缘：

1. 生产机真实吞吐：把压测生成器挪出 `sh2`（本机或第三台机），经边缘打两个容器，跑 `--shards 2` 同口径 ramp，
   拿到真实加速比。现在只有本机 1.93× 和一个被生成器污染的生产读数。
2. 边缘分流：三款游戏各建一个房间，验证「A 房间的玩家在另一片加入不到它」是**符合预期的**，
   同时验证同片内加入正常。只发 `lobby.subscribeRooms` 拿 ACK 不够（每片都注册全部路由）。
3. 数据集多开：选定第 2 节 A/B/C 之一之后，实测并发写/读有没有 `SQLITE_BUSY`、更新器是否只在一片跑。
4. 发布链路：在有授权的前提下做一次两片滚动重启，核对总耗时落在 3 分钟硬超时内。
5. 面板：确认求和后的在线数与逐端口 `/health`（带 `MAINTENANCE_TOKEN` 拿精确值）相加一致。

## 9. 建议

2 vCPU 上分片的收益上界是 ~1.9×，而它当前被「数据集是单一可写文件」这一条卡住，配套还要改边缘、
发布脚本、限流额度与四套观测口径。**建议先走 B 方案的那个小代码改动（`BANGUMI_DB_PATH` + 只读打开）并补第 8 节
的生产实测，再决定要不要真的多开**；在此之前维持单进程。带宽侧没有任何理由做多片——人均 0.006~0.12 Mbps，
200 Mbps 出口在 CPU 饱和前远远用不满。
