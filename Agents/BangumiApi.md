# Bangumi 接入、图床与请求边界

涉及 Bangumi API 镜像配置、图片回填与自建图床、请求队列与隐私边界时使用本文。数据集构建与角色资料见 [BangumiDataset](BangumiDataset.md)，猜番曲目提取、匹配门禁与出题预算见 [BangumiSongMatch](BangumiSongMatch.md)。

| 工作范围 | 查阅章节 |
|---|---|
| API 镜像、图片与回填缓存 | 「配置」「Bangumi API 回填缓存」 |
| 自建图床与运行时更新 | 「自建图床与运行时更新」 |
| 请求边界、排队与隐私 | 「请求边界」「隐私与协议」「排队与截止预算」 |
| CEE 角色查询、目录或资料补全 | [BangumiDataset](BangumiDataset.md) 的对应小节；游戏权限见 [CEE](CEE.md) |

听歌猜番使用 Bangumi 条目作为答案，服务端负责所有 Bangumi 网络请求。客户端只通过
`/api/songuessr/ws` 对应的 WebSocket 命令搜索条目和提交 subject ID，不直接访问 Bangumi
API；图片由服务端按下节配置重写。

CEE（二刺猿笑传之猜猜呗增强版）复用同一份本地数据集与镜像配置，角色数据见 [BangumiDataset](BangumiDataset.md)。

## 配置

在 `Server/.env` 配置：

```bash
BANGUMI_API_URL=https://api.bgm.tv
# 自建图床：avif 分片所在目录，缺省 Server/data/images
BANGUMI_IMAGES_DIR=
# 图床回源前缀：留空 = 只服务已缓存的图；要缺图自愈才配
BANGUMI_IMAGE_SOURCE=
# 选填：角色标签增量地址；不配就不跑增量同步（上游 diff 产物并不长期存在）
BANGUMI_TAG_DIFF_URL=
# 运行时更新器：缺省只在生产开启（测试与本地开发不打线上上游）
BANGUMI_UPDATER_ENABLED=
BANGUMI_UPDATER_MIN_RATE=10
BANGUMI_UPDATER_MAX_RATE=100
BANGUMI_UPDATER_PLAYER_SCALE=20
# 选填：Bangumi API 回填缓存落点，默认 Server/storage/bangumi-enrichment.sqlite
BANGUMI_ENRICHMENT_PATH=
```

`BANGUMI_API_URL` 应指向兼容 Bangumi v0 API 的镜像（**具体地址属于部署配置，不进仓库**）。

**图片前缀写死 `/api/bangumi`，没有环境变量开关**：所有 Bangumi 图片都改写到自建图床
（与后端同源，直接读本机那份 avif 缓存），不再把 Bangumi 源站地址发给浏览器 ——
`lain.bgm.tv` 在国内多数网络根本连不上，等于没有封面。
改写规则：`lain.bgm.tv` 原始地址 → 「`/api/bangumi` + 图床缓存路径」（方形一律 `grid`、
长条一律 `large`，作品封面向下降档），映射不了的形状原样返回。
**注意**：对外前缀是相对路径，回源因此**没有缺省值**（跟着它回源 = 自己回自己的死循环），
要让图床自己去抓缺失的那几张，得显式给 `BANGUMI_IMAGE_SOURCE`。
前缀刻意不开放配置：一旦可配就必然有人配出边缘不放行的路径，线上整站图片会变成 SPA HTML。

## 生产部署：为什么图床要挂在 `/api` 下

前端挂在阿里云 ESA（`game.baka.website`，站点 `baka.website`），由一个**边缘函数** `bakagame-esa`
托管 SPA；它的函数路由 `game-frontend` 的匹配条件是「**非** `/api`、非 `/health` `/readyz` `/livez`
的所有路径」。也就是说：**任何不落在 `/api` 下的服务端路径都会被这个函数吃掉**——请求根本到不了后端，
直接返回 SPA 兜底的 HTML，`<img>` 拿到网页字节就是裂图。

所以图床对外前缀用 `/api/bangumi`：**`/api/*` 本来就在放行名单里，边缘不需要任何改动，也不需要额外的
回源规则**（默认源站直接出 avif）。
**新增后端路径请一律挂在 `/api/` 下**，能省掉一次边缘配置。

排查同类问题的顺序（`ListSiteRoutes` → `GetOriginRule` 全局配置 → `ListSiteFunctions`）：
先确认请求有没有被边缘函数路由拦截，再谈回源。ESA 配置改动约 30–60 秒下发。

回源端只要满足两点就能用：`GET <源站路径>` 带 `Accept: image/avif` 时返回 avif（ ESA 类反代会实时转码，
校验 avif 魔数 `ftypavif`），且保留源站路径与查询串——图床入库前会校验 avif 魔数，拿到 jpeg / 错误页一律丢弃不入库。

镜像端点的两个要点（与具体域名无关）：`GET /v0/characters/{id}` 返回完整角色 JSON，
其中 `images.medium` 仍指向 `lain.bgm.tv`（由写死的 `/api/bangumi` 前缀重写）；
**它的 `infobox` 是 `[{ key, value }]` 数组**，与归档 dump 的 wikitext 字符串形态不同，
**两套解析器不可混用**。

## Bangumi API 回填缓存

只读数据集里 `subjects.image` / 角色的图片列**始终为空**（构建脚本不写图片），所以图片只能回源。
回填缓存就是「用 API 数据更新数据库」的落地形态——只读数据集发布到 R2（不进 Git，
见 [Server/data/README.md](../Server/data/README.md)），**不能被运行时写入**，补充数据因此单独存一张可写表：

```
Server/storage/bangumi-enrichment.sqlite      （可写，不进 Git；`.gitignore` 已忽略该文件名）
  enrichment(entity TEXT, id INTEGER, payload TEXT, fetched_at INTEGER, PRIMARY KEY(entity, id))
    entity ∈ { 'subject', 'character' }      ← 猜歌与猜番共用同一张表
    payload = { image?: string }
```

**四条必须遵守的规则：**

1. **只存上游原始 URL，不在缓存里存镜像地址**。镜像地址在读取时按 `/api/bangumi` 前缀重写，
   所以换图床不需要清缓存、也不需要重新回源。反过来把重写后的 URL 写进缓存，
   等于把镜像地址钉死在数据里。
2. **失败绝不固化**。上游超时/报错/非 2xx/无图，既不写回填缓存，也不进内存正缓存，
   只记 **5 分钟内存负缓存**（`NEGATIVE_CACHE_TTL_MS`）挡住重复打爆上游，进程重启即失效。
   `resolveImage()` 不得在 `catch` 里把 `undefined` 写进内存正缓存：一次瞬时超时就会让该条目在进程剩余生命周期里**永远没有图片**；联网 Provider 的 `cached()` 同样会把失败与空结果缓存满 TTL，所以
   `resolveCharacterImage` 刻意**不复用它**、只缓存成功结果。
3. **配置错误响亮失败，运行期异常降级放行**。构造时 `enrichmentPath` 打不开/建不了目录
   直接抛错（静默降级会让缓存「悄悄不生效」）；但使用期的读写异常只 `console.warn` 并跳过本次，
   缓存是优化而非真相源，不能因为一个损坏的缓存文件让整个出题链路挂掉。
4. **跨 Worker 只传可克隆参数**。Provider 跑在 Worker 里，`BangumiProviderInit`
   刻意排除了 `fetcher`（函数无法结构化克隆），缓存路径必须随 `init` 一起传入。

角色立绘走 `GET /v0/characters/{id}`，图片字段结构与条目一致
（`images.medium / large / common / grid` 依次回退），由 `resolveCharacterImage(characterId)` 暴露，
**猜番（CEE）与猜歌共用同一条回源与缓存路径**。非法 id（非正整数）直接返回 `undefined`，不回源。
CEE 作品封面同样回填到 `enrichment` 的 `subject` 实体（与猜歌共用一行），由 `CEEEnrichment.resolveSubjectImage` 回源
`GET /v0/subjects/{id}`，规则与角色立绘相同：请求按 `实体:编号` 合并，无图或 404 只进 5 分钟内存负缓存，其他失败原样报错。
作品列表查询（搜作品、按编号取作品）只读已回填的封面、不回源；缺图的条目由客户端滚进视口时经 `cee.subject.image` 按需补，
本地不存在或 NSFW 的条目直接返回 `undefined`。

## 自建图床与运行时更新

数据集不由 CI 定期重建：**库是可写的，由后端自己更新**（构建工具在 `tools/`，不进 Git）。
图床与更新器都跑在数据 Worker 里，写操作因此收口在单一线程。

### 自建图床

- 分片存储 `Server/data/images/images-XX.sqlite`（`crc32(path) % 分片数`，分片数按目录里
  实际存在的文件推断，与构建脚本一致）。表 `images(path, bytes, content_type, fetched_at)`。
- 路由 `GET /api/bangumi/*`：**命中直接回 avif**（`immutable` 长缓存），缺失才回源
  （`Accept: image/avif`），回源结果转交 Worker 落库 —— 主线程只读分片，单写者不变。
- **回源配额是两层，先扣个人再扣全局**：单客户端 30/min、全局 120/min。顺序不能反，
  否则一个扫描者用随机路径把共享预算吃光，正常玩家就再也回不到源。命中缓存不占额度，
  同一张图的并发请求合并成一次回源、也不重复扣。分桶键只采信 `X-Real-IP`（口径同
  [Deployment](Deployment.md#反向代理职责)）。
- **配额用完是 429，不是 404**：`fetch` 返回 `state: "limited" | "missing" | "ok"`，
  路由据此映射 429（带 `X-RateLimit-*` 与 `Retry-After`）/ 404。把「额度没了」伪装成
  「这张图不存在」会让客户端缓存失败结论、让运维查不到原因，也必须让上游知道该退避。
- 只认 avif 魔数：上游返回错误页 / jpeg 时**绝不入库**（坏字节一旦入库就再也不会重下）。
- **响应类型走白名单**：`content_type` 是库里的自由字符串，白名单（avif/png/jpeg/webp/gif）
  之外一律降级为 `application/octet-stream` —— 浏览器可直接导航到图片 URL，
  人工导入或旧数据误写的 `text/html` 不能被当作页面渲染。
- 路径与 Bangumi 源站一致，所以图床换部署形态（同源 / 反代 / 上游）都不需要改 URL 改写逻辑。

### 运行时更新器（`SubjectUpdater`）

- **三层**：按热度排名分位划分间隔（前 20% 两天 / 前 50% 一周 / 其余一个月），
  分位**每轮按当前热度分布重算**，作品变热自动刷得更勤。
- **按玩家数限速**：0 人 → `MIN_RATE`（10 req/s，字面意义上慢慢更新），
  在线玩家达到 `PLAYER_SCALE`（20）→ `MAX_RATE`（100 req/s），中间线性。
  所有回源（含补图）都过同一个时隙队列。
- **按需**：玩家点开过的条目登记进队列，下一轮优先刷新且不受单轮上限挤掉；
  只对「确实过期」的条目发请求。
- **索引同步**：落库后只把 id 写进 `bangumi_index_pending`，轮末批量 flush 到 Meilisearch；
  失败计数重试，超过 5 次丢弃（下一轮刷新会重新入队）。
- **失败退避**：1h → 2h → 4h … 封顶一周；成功即清零。
- **nsfw 守卫**：上游标成 nsfw 的条目**不落库**，并推后 30 天再问。
- **备份期间暂停**：`VACUUM INTO` 出一致快照时不写库。
- 状态表建在数据集里（`bangumi_refresh` / `bangumi_index_pending`），与它描述的数据同生共死。
- 首轮必须先把现有作品登记为「此刻已刷新」（`markDatasetFresh`），**不得**一上线就全库刷新一遍。

## 请求边界

Bangumi 请求统一由 `Server/src/infrastructure/BangumiProvider.ts` 发起：

- `POST /v0/search/subjects` 用于条目搜索和自动出题筛选，查询类型固定为动画（type 2）。
- `GET /v0/subjects/{id}` 用于读取条目详情、图片、评分、标签和 infobox。
- `GET /v0/subjects/{id}/subjects` 用于获取番剧关联条目，筛选关联类型为音乐（type 3）的曲目条目，与 infobox 主题曲信息融合互补。
- 搜索结果缓存 6 小时，条目详情与关联音乐缓存 24 小时；缓存为最多 512 项的 LRU，且相同键的并发请求共享一个 Promise。
- 请求由并发数为 3 的队列调度；上游返回 429 时进入 5 秒冷却、取消等待请求，并返回 `BANGUMI_RATE_LIMITED`。
- 上游非 2xx、返回无效 JSON 或未配置 Provider 时转换为明确的 Bangumi 业务错误。
- 图床回源与 CEE 图片提示的出站抓取统一走 `OutboundGuard`：禁用自动跳转、逐跳复核目标地址，
  回源只允许留在 `BANGUMI_IMAGE_SOURCE` 同源；边界与残余风险见 [Deployment](Deployment.md#服务端出站图片与头像抓取)。

## 隐私与协议

`song.bangumi.search` 只返回公开条目摘要；`song.game.submitAnime` 和
`song.game.guessAnime` 只传输 subject ID。当前回合的番剧答案仅在出题人的私有状态、旁观者
私有状态或回合结算摘要中公开，猜测玩家在结算前只能看到自己的猜测记录。

## 排队与截止预算

Bangumi 请求使用有界并发队列，排队、请求和响应体解析共享同一截止预算；超时必须取消排队或在途请求并释放槽位，限流冷却不能留下挂起任务。测试注入请求函数，不访问真实上游。

角色搜索排序先为候选生成一次评分摘要，再由纯比较器排序；比较器不得重复触发补充资料查询。

CEE 图片提示跨键共享有界下载与解码队列，同键合并。排队、读取及解码共用截止预算，取消需释放读取器和解码资源；缓存同时限制条目数与字节数，不能仅依赖输入图片大小限制。
