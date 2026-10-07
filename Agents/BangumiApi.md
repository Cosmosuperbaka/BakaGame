# Bangumi 接入与数据集规范

涉及 Bangumi API、歌曲匹配、SQLite 构建或 CCB 角色资料时使用本文；按数据链路查阅，不要求先通读另一个游戏的规则。

| 工作范围 | 查阅章节 |
|---|---|
| API 镜像、图片与缓存 | 「配置」「Bangumi API 回填缓存」「请求边界」 |
| 猜番出题与歌曲匹配 | 「番剧题目」「出题性能预算」「曲目过滤与展示」「隐私与协议」 |
| 数据构建、标签与声优 | 「本地数据集构建」下对应小节 |
| CCB 查询、目录或资料补全 | 「角色库检索的已知限制」「CCB 运行时资料与补全边界」；游戏权限见 [CCB](CCB.md) |

听歌猜番使用 Bangumi 条目作为答案，服务端负责所有 Bangumi 网络请求。客户端只通过
`/api/songuessr/ws` 对应的 WebSocket 命令搜索条目和提交 subject ID，不直接访问 Bangumi
API；图片由服务端按下节配置重写。

CCB（猜动漫角色）复用同一份本地数据集与镜像配置，角色数据见文末「本地数据集构建」。

## 配置

在 `Server/.env` 配置：

```bash
BANGUMI_API_URL=https://api.bgm.tv
BANGUMI_IMAGE_URL=
# 选填：Bangumi API 回填缓存落点，默认 Server/storage/bangumi-enrichment.sqlite
BANGUMI_ENRICHMENT_PATH=
```

`BANGUMI_API_URL` 应指向兼容 Bangumi v0 API 的镜像（**具体地址属于部署配置，不进仓库**）。
`BANGUMI_IMAGE_URL` 为空时保留原始图片地址；配置后，服务端只重写主机名为 `lain.bgm.tv`
的图片链接。重写结果使用镜像源和原链接的 pathname、query、hash，其他主机名和无效 URL 原样返回。

镜像端点的两个实测要点（与具体域名无关）：`GET /v0/characters/{id}` 返回完整角色 JSON，
其中 `images.medium` 仍指向 `lain.bgm.tv`（必须靠 `BANGUMI_IMAGE_URL` 重写）；
**它的 `infobox` 是 `[{ key, value }]` 数组**，与归档 dump 的 wikitext 字符串形态不同，
**两套解析器不可混用**。

## Bangumi API 回填缓存

只读数据集里 `subjects.image` / 角色的图片列**始终为空**（构建脚本不写图片），所以图片只能回源。
回填缓存就是「用 API 数据更新数据库」的落地形态——只读库是 LFS 产物、每周被 CI 重建，
**不能被运行时写入**，补充数据因此单独存一张可写表：

```
Server/storage/bangumi-enrichment.sqlite      （可写，不进 Git；`.gitignore` 已忽略该文件名）
  enrichment(entity TEXT, id INTEGER, payload TEXT, fetched_at INTEGER, PRIMARY KEY(entity, id))
    entity ∈ { 'subject', 'character' }      ← 猜歌与猜番共用同一张表
    payload = { image?: string }
```

**四条必须遵守的规则：**

1. **只存上游原始 URL，不在缓存里存镜像地址**。镜像地址在读取时用 `BANGUMI_IMAGE_URL` 重写，
   所以换镜像源不需要清缓存、也不需要重新回源。反过来把重写后的 URL 写进缓存，
   等于把镜像地址钉死在数据里。
2. **失败绝不固化**。上游超时/报错/非 2xx/无图，既不写回填缓存，也不进内存正缓存，
   只记 **5 分钟内存负缓存**（`NEGATIVE_CACHE_TTL_MS`）挡住重复打爆上游，进程重启即失效。
   **历史事故**：旧 `resolveImage()` 在 `catch` 里把 `undefined` 写进内存正缓存
   （`cacheNegative`），一次瞬时超时就让该条目在进程剩余生命周期里**永远没有图片**；
   联网 Provider 的 `cached()` 同样会把失败与空结果缓存满 TTL，所以
   `resolveCharacterImage` 刻意**不复用它**、只缓存成功结果。
3. **配置错误响亮失败，运行期异常降级放行**。构造时 `enrichmentPath` 打不开/建不了目录
   直接抛错（静默降级会让缓存「悄悄不生效」）；但使用期的读写异常只 `console.warn` 并跳过本次，
   缓存是优化而非真相源，不能因为一个损坏的缓存文件让整个出题链路挂掉。
4. **跨 Worker 只传可克隆参数**。Provider 跑在 Worker 里，`BangumiProviderInit`
   刻意排除了 `fetcher`（函数无法结构化克隆），缓存路径必须随 `init` 一起传入。

角色立绘走 `GET /v0/characters/{id}`，图片字段结构与条目一致
（`images.medium / large / common / grid` 依次回退），由 `resolveCharacterImage(characterId)` 暴露，
**猜番（CCB）与猜歌共用同一条回源与缓存路径**。非法 id（非正整数）直接返回 `undefined`，不回源。
CCB 作品封面同样回填到 `enrichment` 的 `subject` 实体（与猜歌共用一行），由 `CCBEnrichment.resolveSubjectImage` 回源
`GET /v0/subjects/{id}`，规则与角色立绘相同：请求按 `实体:编号` 合并，无图或 404 只进 5 分钟内存负缓存，其他失败原样报错。
作品列表查询（搜作品、按编号取作品）只读已回填的封面、不回源；缺图的条目由客户端滚进视口时经 `ccb.subject.image` 按需补，
本地不存在或 NSFW 的条目直接返回 `undefined`。

## 请求边界

Bangumi 请求统一由 `Server/src/infrastructure/BangumiProvider.ts` 发起：

- `POST /v0/search/subjects` 用于条目搜索和自动出题筛选，查询类型固定为动画（type 2）。
- `GET /v0/subjects/{id}` 用于读取条目详情、图片、评分、标签和 infobox。
- `GET /v0/subjects/{id}/subjects` 用于获取番剧关联条目，筛选关联类型为音乐（type 3）的曲目条目，与 infobox 主题曲信息融合互补。
- 搜索结果缓存 6 小时，条目详情与关联音乐缓存 24 小时；缓存为最多 512 项的 LRU，且相同键的并发请求共享一个 Promise。
- 请求由并发数为 3 的队列调度；上游返回 429 时进入 5 秒冷却、取消等待请求，并返回 `BANGUMI_RATE_LIMITED`。
- 上游非 2xx、返回无效 JSON 或未配置 Provider 时转换为明确的 Bangumi 业务错误。

## 番剧题目

手动出题先搜索条目，再读取详情并从关联音乐条目与 infobox 中提取曲目信息（覆盖 OP、ED、插曲、主题歌、OST、Remix、角色曲、印象曲、同人音乐、Vocaloid、Drama、VOCAL、Radio、Arrange、单曲、精选集、朗读剧、艺人专辑共 18 种曲目类型）。提取曲目时严格通过正则排除 `分镜`、`演出`、`制作`、`作画`、`作词`、`作曲`、`编曲` 等制作人员 Staff 字段，避免制作人员被误识别为歌名。曲名支持多书名号提取与斜杠拆分（如单曲 `メグメル／だんご大家族` 拆分为独立曲目），并关联主题歌演出歌手。

服务端使用提取出的曲名与歌手调用网易云 Provider：
1. **限定检索策略**：在没有明确歌手信息时，检索关键词自动附加番剧原名与中文译名（如 `${track.title} ${anime.name}`），消除重名歌曲干扰。曲目带有歌手信息时，仍会一并追加番剧原名、中文译名与纯曲名宽检索，避免 Bangumi 与网易云的歌手写法差异导致原版漏召回、只剩翻唱版可匹配。**但过长的歌手名不得拼进检索词**：Bangumi 的 `artist` 常是整串声优列表（角色歌专辑动辄七八个人名），拼进去会把检索词毁掉，网易云什么都搜不到（阈值 `MAX_ARTIST_QUERY_LENGTH = 32`）。这一条是**补录 artist 之后才暴露的副作用** —— 旧库 artist 全为 NULL，等于一直在走番剧名那条路。**改数据列时必须回头检查读取它的每一处。**
2. **歌名匹配度门禁**：采用 `isSongTitleMatch` 校验网易云返回歌曲标题与 Bangumi 曲名（规范化并剥离 `(TV Size)` 等版本后缀），拒绝与目标曲名不符的异形搜索结果。三条不变量：
   - **多曲并列先拆段**：条目名里的 `/`、`／`、`・`、`&`、`+`、`feat.` 是「双 A 面单曲 / 合作曲」的分隔符，拆段后任一段完全一致即命中（Bangumi《メグメル／だんご大家族》对候选《だんご大家族》）。不拆段就会被下面的截断门槛误伤；
   - **正向子串（候选名更长）保持宽松**：`曲名 - 番剧名`、`曲名 (TV Size)` 是合法常态，照旧放行；
   - **反向子串（候选名更短）必须收紧**：要求短名 ≥ `MIN_TRUNCATED_TITLE_LENGTH`(4) 且占长名比例 ≥ `MIN_TRUNCATED_TITLE_RATIO`(0.6)。实测《いつだってYELL》（忍者乱太郎 ED）匹配上 2026 年**毫无关系**的《Yell》、《ぼくらは小さな悪魔》匹配上《ぼくら》，都是旧版「较短一方 ≥ 2 字符即可子串匹配」放进来的。
3. **曲名命中或专辑名命中**：候选必须与曲目相关，判定为「曲名命中」（`isSongTitleMatch`）**或**「专辑名与曲目名完全一致」（`isSongAlbumMatch`，共享导出）。专辑名命中是**必需的第三条召回通道**：Bangumi 会把整张原声带挂成一条关联曲目（曲目名 = 专辑名，如《君の名は。》），官方原声带里真正的曲目（`前前前世` / `スパークル`…）只有专辑名能命中，而按曲名检索只能召回同名器乐改编（实测帝玖管弦乐团《交响组曲「君の名は。」》顶掉了官方原版）。
4. **原版优先排序**：通过门禁的候选歌先经 `scoreAnimeSongCandidate` 打分降序排列再依次验证可播放性，评分维度固定为六项：
   - 曲名相似度：完全一致 2 / 包含 1；
   - **专辑名与曲目名完全一致 +2**：原唱原版通常发行在同名专辑/单曲里（YOASOBI《勇者》的专辑名就是《勇者》），同名翻唱挂在《勇者-葬送的芙莉莲OP》这类自建合辑下，曲名并列时专辑名是唯一能区分原版的免费信号；
   - **番剧上下文命中 +3**：候选出现在「曲名 + 番剧名 / 中文名」的检索结果里，是该曲目确实属于这部番的强证据。**同名不同曲**（实测 TV 动画《拜托了老师》(2002) 的 OP `Shooting Star` 被 2023 年 XG 的同名《SHOOTING STAR》顶掉）里，别人家的同名原创只会在裸曲名检索里出现，而原版总跟着番剧名一起被召回 —— 这也是第 1 步必须保留「曲名 + 番剧名」检索词的原因。取 3 的由来：别人家的同名原创常拿满「曲名 + 专辑名」4 分，而番剧原版的专辑名多为「番剧名 - 曲名」形态只拿 2 分，加 3 后恰好反超，又不会盖过「歌手交集 +4」这条更硬的证据。
   - 歌手与 Bangumi 记录有交集 +4 / 无交集 -3（Bangumi 未记录歌手时不参与加减分）；
   - 命中非原唱标记降权：翻唱 -5、伴奏/纯音乐/现场等 -4、**器乐改编 -5**（交响 / 管弦 / 钢琴 / 演奏 / `arrange` / 八音盒 等二次演绎）；
   - 标记词**只在 Bangumi 曲目自身没有该标记时生效**，避免把题面本身就是 Cover / Arrange / Remix 的曲目所有候选一起降权（等同随机）。
   网易云会把翻唱、器乐改编版本混排在原版之前，此排序确保原版存在时不被抢占；仅能召回翻唱版时仍正常出题，不因缺少原版而失败。

**准入证据必须与排序分解耦（必须遵守）**：候选能否进入验证队列由 `hasAnimeSongEvidence` 判断，**不复用** `scoreAnimeSongCandidate` 的分数。两条规则与理由：

- **曲子对不上就出局**：曲名完全一致 → 准入；专辑名与原曲目名完全一致 → 准入（Bangumi 把整张原声带挂成一条关联曲目时，官方曲目名与条目名毫无文字交集，只有专辑名能证明「它是这张专辑里的歌」）；曲名只部分命中 → 必须另有独立证据（歌手交集 / 番剧上下文命中）；其余出局。实测《夢を信じて》（勇者斗恶龙）前 5 名全是翻唱 / 加速改编版，原版徳永英明只排第 6，弱候选只靠曲名部分命中就拿到了出题资格。
- **非原唱标记的降权不得参与准入**：降权是「是不是原版」的判断，属排序。若把它算进准入，唯一候选恰好是翻唱 / 器乐改编的曲目会直接退化成「该番剧没有可播放的关联歌曲」，把「有歌可出优先」的兜底一并打掉。
- **曲名完全一致时不看歌手**：翻唱常把曲名照抄，Bangumi 与网易云的歌手写法差异也常让交集为空 —— 用歌手否掉会让真正的原版连被验证的机会都没有。

**翻唱必须让位，并凭原曲 ID 回指原版（必须遵守）**：`/api/v3/song/detail` 的 `originCoverType`（`1` 原唱 / `2` 翻唱）是**唯一可靠**的版本信号 —— 文本维度在翻唱面前全失效（实测《裸の勇者》Vaundy 原版与柯奇翻版曲名、专辑名一字不差）。三条不变量：

- 该字段**只在歌曲详情里返回**，检索结果不带，因此让位只能发生在候选验证阶段，进不了检索排序；
- `originCoverType === 2` 的候选记为 `fallbackCover` 并**不占用 `ANIME_TRACK_DETAIL_ATTEMPTS`**（与年份错配同理，否则成批排在前的翻唱会吃光验证名额）；兜底优先级为 近期重复的正确歌 > 年份错配 > 翻唱，翻唱最后才认；
- **翻唱自带的 `originSongSimpleData.songId` 要用来回指原版**：原版常常压根没进候选池（实测《你所不知道的故事》—— Bangumi 存中文译名，按译名检索只召回中文重填词的翻唱，日文原版《君の知らない物語》永远进不了池子），此时把该 ID 插到队首交给下一次迭代，比补检索词更直接。用一个 `Set` 去重，防止翻唱互相指向反复插队。

**专辑型条目走「搜专辑 → 取专辑曲目」（必须遵守）**：Bangumi 把大量资源挂成**整张专辑**条目，条目名就是专辑名（《マジンブーン オリジナルサウンドトラック2》《キラッとプリ☆チャン♪ソングコレクション》《B-PROJECT～絶頂＊エモーション～ キャラクターソングCD 2》），拿它当歌名检索单曲必然一无所获。规则与原因：

- **触发条件**：常规检索的候选池为空、且条目 kind 不是非音乐类，才走 `resolveAlbumTrackCandidates`（`provider.searchAlbums` + `getAlbumSongs`）。猜番模式下玩家猜的是番剧名，曲目名只用于结算展示，所以专辑里的歌都可以出题；
- **kind 用黑名单制，不是白名单**：只有 `drama` / `radio` / `reading`（广播剧 / 电台 / 朗读）被排除，其余一律允许兜底。第一版按白名单只放开 character / image / theme 等「专辑型」，结果实测 `opening` / `ending` 条目里同样塞着整张角色歌 CD，那些条目永远零候选 —— **不要按「看起来像单曲」推断条目形态**；
- **检索词必须覆盖番剧名，不能只搜条目名**（`buildAlbumQueries`）：按「条目名 → 剥掉
  `TVアニメ『番剧名』` 包裹后的余部 → 番剧名 + 类型关键词（`キャラクターソング` /
  `オリジナルサウンドトラック` 等）→ 番剧原名 → 番剧中文名」逐级放宽。**只用条目名会全军覆没**：
  《TVアニメ『ひみつのアイプリ』キャラクターソングミニアルバム VERSE IN SONG 03》搜专辑返回
  **0 张**，换成番剧名「ひみつのアイプリ」立刻搜到同系列专辑；《「クラスターエッジ」
  キャラクターコレクション》连番剧的日文片假名都搜不到，而**原名** `CLUSTER EDGE` 能搜出该番的
  《ココロのつぼみ》《FLY HIGH》—— 番剧原名常常是英文，与 Bangumi 的中文 / 日文名都不一样。
  （`/api/search/suggest/multimatch` 实测匿名态返回 `{"result":{"orders":[]}}`，**不可用**，别指望它。）
- **专辑名用相似度分，而不是「必须对得上」**（`albumNameScore`）：100 全等 / 60 互相包含
  （短名 ≥ 4 字符）/ 10+ 「专辑名含番剧名」且共享一个 ≥ 4 字符的特征词元（数字序号命中额外 +20）。
  网易云与 Bangumi 的命名**必然有出入**：上面那个条目在网易云叫
  《TVアニメ『ひみつのアイプリ リング編』VERSEIN SONG 03》—— 缺「キャラクターソングミニアルバム」、
  多「リング編」、「VERSEIN」还没空格，只用全等/包含会把真专辑全部判死；序号加分是为了不抽到
  同一系列的隔壁那张（**02** 与 **03** 的差别全在序号上）。判据**不能只看长度比例** ——
  实测《角色歌合辑》与《另一部番 OST》长度接近，按比例会被误判成同一张专辑。
- 专辑里曲名带伴奏 / 纯音乐 / 现场 / 翻唱标记的分轨（`isUnplayableAlbumTrack`）直接剔除，OST 与角色歌合辑常把 off vocal 一并收录；
- **曲目要读顶层 `body.songs`**：`/api/v1/album/{id}` 的 `album.songs` 在同名 / 单曲专辑上是**空数组**，写成 `album.songs ?? body.songs` 会因为 `??` 不回退而静默拿到空列表 —— 实测《風がそよぐ場所》顶层 2 条、`album.songs` 0 条，整条专辑路径因此失效（探针里 searchAlbums 明明命中）。`NeteaseMusicProvider.test.ts` 有回归用例钉死读取顺序；
- **同名专辑优先选艺术家对得上的那张**（数据集补录 artist 之后这条才可用），都对不上时退回第一张交给验证阶段筛。
- **最后一道兜底是「番剧级检索」**（`resolveAnimeLevelCandidates`）：条目级解析全失败时，用番剧名
  搜**单曲**，只保留能证明属于该番的候选 —— 专辑名含番剧名，或歌名与该番**任一** Bangumi
  曲目标题一致（跨条目互证）。代价是可能出到该番的**其它**曲目而非条目指名的那张专辑；
  猜番模式下玩家猜的是番剧名，出一首确实属于该番的歌远好于整条出不了题，这是可接受的取舍。
- **兜底路径不认翻唱降级**：专辑 / 番剧级兜底已经放宽了「哪首歌」，不该再把「是不是原版」
  一起放宽 —— 实测番剧兜底会召回该番的**日语翻唱版**并出题。只有常规检索路径保留翻唱兜底
  （原版是会员专享且解灰失败时，有歌可出优于出不了题）。

**同名不同曲必须用发行年兜底（必须遵守）**：文本维度对「曲名与专辑名都撞车」的同名歌无能为力，因此 `resolveAnimeSong` 在候选验证阶段还要做一次年份校验（`isReleaseYearOffTarget`，容差 `MAX_RELEASE_YEAR_DRIFT = 10` 年、对称）：`|候选发行年 − 番剧首播年| > 10` 即视为错配，记为 `fallbackYear` 并继续找。四条不变量：

- 发行年**只在歌曲详情里返回**（检索结果不带），所以这条只能在验证阶段生效，进不了排序；
- **年份错配的候选不得占用 `ANIME_TRACK_DETAIL_ATTEMPTS`**：同名新歌成批排在前面（实测 XG / chuLa / Anna Yvette / GX.MARK 都是「曲名 + 专辑名」双命中的 4 分），若让它们吃掉 3 个验证名额，排在后面的原版连被验证的机会都没有；整体仍受 detail 预算约束，不会无界回源。
- 容差取 10 是刻意宽松：既挡住跨代错配（2023 vs 2002 = 21 年），又保留「若干年后的纪念盘 / 精选集」这类同一首歌的合法再版（KOTOKO 的 2012 特典盘与 2002 原版是同一录音，偏差正好 10 年）。
- 候选年份**未知时放行**（实测 GX.MARK 的详情没有 `publishTime`，靠「番剧上下文命中」区分）；全部候选都错配时才用 `fallbackYear`，优先级低于「近期重复过的正确歌曲」。
5. **近期题目防重缓冲**：房间维护近期番剧 ID（`recentSubjectIds`，固定 10 轮）与近期歌曲 ID（`recentSongIds`）滑动窗口，自动出题和曲目解析优先避让近期出题历史，杜绝连续多轮抽中同一部番或同一首歌。
   歌曲窗口长度按候选池自适应：`resolveRecentSongWindow(pool)` 取池的一半，下限 10、上限 500，池不超过 20 首时与固定 10 首等价。三条不变量：
   - 窗口长度必须取自**过滤会员曲后的整池**，并用**同一个数值**排除近期曲目与写入 `installRound`；口径不一致会让去重形同虚设。
   - 窗口**不得**由「扣除近期后的剩余」反推：池子被扣小时窗口会跟着缩，等价于每回合自动放宽去重。
   - 只有自动选曲知道候选池规模；手动出题与猜番传默认窗口。实测：池 990 首时前 495 轮不出现旧歌，池 15 首时行为与改动前的固定 10 轮一致。

**所有通过筛选的曲目必须等概率（必须遵守）**：`resolveAnimeSong` 必须先对「通过 `trackKinds` 筛选的曲目」做一次洗牌（`shuffle(..., this.random)`）再截断、遍历，**严禁按数据源给出的顺序取首个可播放曲目**。两个数据源都天然带偏：本地数据集按 `relation_order, music_id` 排列，实测 8083 部番剧里有 3447 部（42.6%）的首条曲目是片头曲；联网 API 早期还额外按 `KIND_PRIORITY` 把 `opening` 排到最前。任一来源保持原序取首个，都会让出题长期偏向片头曲（线上实测近乎每轮都是 OP）。洗牌后截断，使被预算截掉的曲目同样等概率命中，而不是永远只有前几首有机会。

**关联类型码只在服务端映射一次（必须遵守）**：`subject_music_relations.relation_type` 到曲目类型的映射以 `LocalBangumiProvider.RELATION_KINDS` 为唯一真相源：`3003` 片头曲、`3004` 片尾曲、`3005` 插入歌、`3002` 角色歌、`3006` 印象曲、`3001` 主题歌/原声带，`3007` / `3099` / `0` 回退文本判定。**历史事故**：旧映射把 `3002~3005` 整体错位一格（`3002→opening`、`3003→ending`），把片头曲标成 ED、角色歌标成 OP，于是「按曲目类型筛选」实际选出的是完全错误的曲目。核对依据（可用真实数据集复现）：鬼滅の刃 3003=`紅蓮華`(OP)、3004=`from the edge`(ED)；けいおん! 3003=`Cagayake!GIRLS`(OP)、3004=`Don't say "lazy"`(ED)、3005=`ふわふわ時間`(插入歌)、3002=イメージソング系列(角色歌)；SPY×FAMILY 3003=`ミックスナッツ`(OP)、3004=`喜劇`(ED)。修改映射必须同时改 `tools/build_bangumi_db.py` 与 `Server/test/LocalBangumiProvider.test.ts` 的关系码断言。

## 出题性能预算

自动出题要连续回源多个外部接口，冷缓存下必须按**真实成本**设预算，否则一次出题会退化成数百个上游请求（实测最坏 60s+，前端按钮动画都等超时了，后端其实还在选曲）：

- `ANIME_SONG_SEARCH_BUDGET`（24）：单次曲目解析允许发起的**搜索**次数，一次搜索 = 一个上游请求，成本最低。
- `ANIME_SONG_DETAIL_BUDGET`（6）：单次曲目解析允许回源验证的**候选歌曲**数量。每次验证要拉取完整歌曲详情（详情 + 百科 + 热度 + 歌词 + 音频，约 5~6 个上游请求），成本是一次搜索的六倍以上，**严禁与搜索共用同一个计数预算**（把 `getSong` 按「一次调用」记账正是历史性能事故的根因）。
- `ANIME_TRACK_DETAIL_ATTEMPTS`（3）：同一曲目内最多验证的候选版本数。
- `ANIME_SONG_SEARCH_LIMIT`（24）：单次检索取回的结果数。过小会漏掉原版（网易云会把翻唱、器乐改编混排在前面），过大只是白解析。
- `AUTO_ANIME_CANDIDATE_LIMIT`（5）：单次出题最多尝试的番剧候选数。

三条强制规则：

1. **候选详情必须逐首短路**：验证候选时按原版优先顺序逐个 `getSong`，首个可播放即停止，**严禁为同一曲目的多个候选并行拉取完整详情**——并行验证会把被丢弃候选的成本也付一遍（实测并行窗口 4 时，命中第一个候选也要发 4 次详情回源）。同一曲目的多个**检索词**无依赖，仍必须 `Promise.all` 并行。
2. **不按会员状态预剔除候选**：会员专享曲由 `getSong` 的解灰链路取回完整音频，**账号是不是会员不参与出题判定**，可用性一律以「实际拿到的音频」为准；严禁重新加回「非会员房间里 `requiresVip` 的候选先剔除」这类判定。解灰拿不到整曲时 `getSong` 抛 `SONG_UNAVAILABLE`，候选级调用方把它当成「这个候选不能用」继续换下一个（歌单自动出题受 `AUTO_SONG_CANDIDATE_LIMIT` 约束，猜番受 `ANIME_TRACK_DETAIL_ATTEMPTS` 与预算约束），限流与接口整体不可用必须原样抛出。
   仍然成立的相邻规则：**热度门槛无法由检索结果判定**，退一步用一次廉价的红心数查询（`song_red_count`）先判掉，避免为一个必然被否决的候选拉取歌词与音频。
3. **长任务不得设客户端请求超时**：`song.game.start` 与 `song.game.nextRound` 的耗时由上游决定，客户端必须以 `timeout: 0` 发送（见 `WebsocketClient.send`），并在等待期间每 3 秒 `song.room.requestSync` 同步一次房间状态。**严禁用默认 10 秒请求超时**：那只会制造「后端还在选曲、前端已提示失败」的假失败。


## 曲目过滤与展示

**曲目池必须先剔除版权署名伪条目**：Bangumi 关联条目里混有大量**并非歌曲**的署名占位行——版权方、制作委员会、动画师/作家署名，如 `©BanG Dream! Project`、`©SUNRISE`、`©Visual Art's`、`（C）2006 SUNRISE inc.`、`Ⓒ 創通・タツノコプロ`、`時をかける少女」製作委員会2006`。它们在本地数据集 `subject_music_relations` 中 `music_id` 为**负数**（实测全库 7762 条），却被归到 `opening` 类目，因 `KIND_PRIORITY.opening = 1` 而排在所有真实曲目之前。

若不剔除，`resolveAnimeSong` 会拿「版权署名」去网易云搜歌，再经宽松的子串门禁把完全无关的歌曲当成 OP。**真实事故**：`©BanG Dream! Project` 因规范化后包含 `bangdream`，让 `isSongTitleMatch("Bang Dream!", "©BanG Dream! Project")` 判为同一首，于是把 2019 年专辑《Music For All》里的《Bang Dream!》当作 2023 年《BanG Dream! It's MyGO!!!!!》的 OP。

两道防线缺一不可：

1. **结构判定（本地数据集首选）**：`LocalBangumiProvider` 查询 `subject_music_relations` 时必须带 `music_id > 0`。负数 id 是合成占位行的可靠标志——实测 30792 条正 id 曲目中，零条为版权署名样式。
2. **文本判定（覆盖联网 API 与门禁）**：共享导出函数 `isBangumiCreditsEntry`（`Server/src/shared/SonGuessr.ts`）识别版权/商标/录音权标记（`© ® ℗` 与 `(C)/(R)/(P)` 全角变体）以及不带歌曲语义词的「製作委員会」署名。`LocalBangumiProvider`、`BangumiProvider` 与曲名门禁 `isSongTitleMatch` 共用同一真相源。

**判定规则只准收紧到无歧义标记（铁律）**：切勿把 `♡ / ❤ / ※ / ☆ / Project$ / オール / 单曲 / 精选` 一类规则纳入判定——它们是正常曲名的常用元素。实测教训：加入这些规则会误杀 **126 首正版歌曲**（`unconditional L♡VE`、`♡km/h`、`Love❤Island`、`μ's オリジナルソングCD⑤ にこぷり♡女子道`、`のだめカンタービレ フィナーレ オールシーズンズベスト`、`オールOK!!` 等）。收紧后对 30792 条正 id 曲目**误杀为 0**，同时仍能拦截 6287 条伪条目。任何新增规则都必须用真实数据集全量回归，断言「正 id 误杀 = 0」，并补一条反向用例（见 `Server/test/AnimeCopyrightRegression.test.ts` 与 `Server/test/LocalBangumiProvider.test.ts`）。

选择第一首满足匹配度门禁且可播放的歌曲作为音频（按上述原版优先顺序取首个），并基于网易云歌曲、专辑与标签元数据对曲目类型进行智能精准校准；没有曲目信息、没有可播放歌曲或会员权限不足时拒绝提交，并保持当前出题阶段不变。

**曲目类型校准以歌曲自身标注为准（必须遵守）**：Bangumi 关联条目的分类常比歌曲自身标注更粗——官方 MV、单曲碟会被归到「其他 → 主题曲」，片尾曲的专辑条目也可能挂在「插入歌」下。因此当歌曲元数据（曲名 / 专辑 / 标签）里明确写着片头曲 / 片尾曲 / 插入歌时，**必须以歌曲标注为准确认类型**，优先级高于 Bangumi 的粗分类，否则会出现「片尾曲的歌配着插曲徽章」这类错配。判定统一走共享导出函数 `detectExplicitTrackKind`（`Server/src/shared/SonGuessr.ts`）——服务端 `refineTrackKind` 与客户端结算徽章 `formatTrackKind` 共用同一真相源，严禁各写一套正则。该函数只认可带「曲 / 歌 / テーマ」后缀或完整英文单词（`opening` / `ending` / `insert song`）的写法，避免把普通歌名里偶然出现的 `in`、`ed` 片段误判成插入歌或片尾曲；歌曲无显式标注时保留 Bangumi 原分类。

**曲目类型只在结算摘要公开**：出题阶段的房间快照 `currentRound` 只有 `roundNumber` / `submitterPlayerId` / `audioUrl` / `lyricClip`，**不含 `song` 与 `animeTrack`**；`animeTrack.kind` 仅随 `roundSummary`（回合结算）下发。校验曲目类型的测试与功能必须走「出题 → 结算」路径，不能从出题快照读取。

自动出题支持年份范围、总榜/年榜排名范围与网易云歌曲热度筛选（出题设置移除独立的歌曲类型过滤，默认全量支持所有 18 种曲目）。总榜直接使用 Bangumi 热度排序，年榜会在设置的年份范围内先随机选择一个年份，再按该年份的热度排序取候选作品。候选条目按顺序尝试并避让近期番剧，歌曲热度不达标时优先继续尝试同一作品的其它曲目，只有该作品所有曲目都不可用时才切换作品；全部失败时返回 `BANGUMI_NO_MUSIC`。

每轮结算摘要呈现与“听歌识曲”对齐的完整歌曲详情卡片（包含封面图、曲名、具体曲目类型徽章如 OP/ED/插曲/OST/Remix/角色曲、歌手与专辑、发行年份、语言、标签、别名与百科简介，彻底消除“其它”模糊分类），并公开番剧最多 5 条作品标签，不公开元标签。

## 本地数据集构建

`Server/data/` 下两个只读 SQLite 由 `tools/build_bangumi_db.py` 从 Bangumi Archive dump 生成，
每周一 05:00 由 `.github/workflows/bangumi-data.yml` 重建并提交（LFS）。**角色关系、作品、标签与声优的
运行时判定仅使用这些本地数据**；普通角色查询不得在缺失时回源补查。角色头像及其同次 API 返回的
基础资料、用户明确导入的目录成员使用下述独立补全层，不能写入只读 LFS 产物。

| 文件 | 内容 | 使用方 |
|---|---|---|
| `bangumi-song.sqlite` | `subjects`（动画）/ `music_subjects` / `subject_music_relations` | Songuessr |
| `bangumi-character.sqlite` | `characters` / `subjects` / `character_subject_relations` / `character_tags` / `character_extra_tags` / `character_vas` | CCB |

### 角色中文名与性别只能从 infobox 解析（铁律）

归档 dump 的 `character.jsonlines` 字段是
`id / role / name / infobox / summary / comments / collects` —— **没有 `name_cn`，也没有 `gender`**，
两者只能从 `infobox` 里取。而 infobox 是 **wiki 模板原文**，**键前带一个 `|` 前缀**：

```
{{Infobox Crt\r\n|简体中文名= 鲁路修·兰佩路基\r\n|别名={\r\n[L.L.]\r\n[英文名|Lelouch Lamperouge]\r\n}\r\n|性别= 男\r\n…
```

因此解析必须先去 `|` 前缀再匹配。**历史事故**：旧脚本用 `raw.split("=",1)` 后与 `"简体中文名"` /
`"性别"` 做**全等比较**，`key` 实际是 `|简体中文名` → 永不命中，导致 `name_cn` 与 `gender`
**全库 22 万行均为空**长期无人发现（旁证：同一脚本的音乐路径用的是 `in` **子串匹配**，
所以 `|片头曲` 仍能被命中——「音乐能用、角色不能用」就是这么来的）。

配套约定：

- 抽取逻辑集中在 `parse_infobox()` / `parse_character_infobox()` / `normalize_gender()`，
  支持多值块（`别名={` 逐行 `[值]` / `[类型|值]`，取竖线后的值、丢弃空条目）、`[[内链]]` 清洗。
- 性别归一到 `male` / `female` / `?`（非男非女一律 `?`），与 CCB 反馈判定同一口径。
- **必须保留构建期填充率守卫**：`report_character_stats()` 打印全表填充率，且 `name_cn` /
  `gender` / `character_tags` 任一为 **0 直接让构建失败**。这个 bug 能潜伏这么久，正是因为
  旧构建「成功、且没有任何报警」。
- **必须保留自测**：`tools/test_build_bangumi_db.py`（真实 dump 原文做 fixture + 反例），
  在下载 dump **之前**执行以便快速失败。
- **曲目歌手（`subject_music_relations.artist`）必须在构建期从音乐条目自身的 infobox 解析**：
  `parse_music_infobox_artist()` 同时覆盖单值（`|艺术家= Sound Horizon`）与多值块
  （`|艺术家={` 逐行 `[YOASOBI]`，多艺人时值走 blocks，只读 singles 会整条漏掉）。
  该列**没有别的来源**——`music_subjects` 与 `subject_music_relations` 都不存艺术家，
  一旦落成 `NULL`，`scoreAnimeSongCandidate` 的「歌手交集 +4 / 无交集 −3」整条失效，
  原版优先退化成只看曲名与专辑名。**历史事故**：旧脚本把正 id 曲目的 artist 硬编码为 `None`，
  全库 3 万条曲目带 artist 的为 **0**；而唯一带 artist 的 infobox 解析条目恰好是负数 id
  的伪条目、被 `music_id > 0` 全部过滤 —— 两个缺陷互相掩护，直到「猜番经常选到翻唱」才暴露。
- **只补列时不要重跑完整构建**：完整构建要读 934MB `subject.jsonlines` 全量载入，还会用
  **新一版** `id_tags.js` 覆盖角色标签（本地重建等于把线上标签换成快照）。补 `artist` 这类
  单列走增量补丁即可（读 dump 建 `{music_id: artist}` 再 `UPDATE ... WHERE music_id > 0`），
  幂等且不触碰标签表。
- `build()` 的产物发布顺序不能改：连接必须在 `Path.replace()` **之前**关闭（Windows 不允许
  重命名仍被打开的文件），且临时目录清理必须 `ignore_errors=True`，否则清理失败抛出的
  `PermissionError` 会把填充率守卫的真实报错整个吞掉。

### 角色标签 `character_tags`（每周自动更新，仓库里不存快照）

上游原版的 `client/src/data/id_tags.js`（**32705 角色 / 421 标签**）是**唯一**可得的标签来源：
原版服务端的 `POST /api/character-tags` 与 `/api/game-character-tags` 都只写 MongoDB，
没有任何读回端点。原版**每周会更新**这个文件，所以**不要把快照提交进本仓库**——存下来必然过期。

链路（两端 Actions 都改过，见下）：

```
CCB-TagsCI  weekly-tags-maintenance        北京时间 周一 04:00
   ├─ 同步 guesser fork → 合并用户反馈标签 → 写 outputs/id_tags.js（提交）
   └─ 派发 repository_dispatch: bangumi-tags-updated → BakaGame
BakaGame    bangumi-data.yml               北京时间 周一 05:00（兜底）+ 收到派发立即跑
   ├─ curl 下载 CCB-TagsCI 的 outputs/id_tags.js 到 /tmp/bangumi/id_tags.js
   └─ python3 tools/build_bangumi_db.py <dump> Server/data --tags /tmp/bangumi/id_tags.js
```

- **权威地址**：`https://raw.githubusercontent.com/Cosmosuperbaka/CCB-TagsCI/master/outputs/id_tags.js`
  （注意 CCB-TagsCI 的默认分支是 **`master`**，不是 `main`；guesser fork 才是 `main`）。
- **构建脚本也支持直接给 URL**（`--tags` 默认就是这个地址），本地开发不必先手动下载。
- BakaGame 侧用 `curl --fail --location --retry 3` 下载、下载字节数打进 CI 日志，便于追溯当晚用的是哪一版。
- **定时任务排在 05:00 而不是 04:00**：必须等 CCB-TagsCI 把当晚的标签推完再重建。派发事件是加速路径，
  定时任务是兜底——派发失败（例如 `CI_TOKEN` 对 BakaGame 缺 `repo` 权限）时仍能在一小时内自我修复。
- 脚本只认结尾 `}` 前的对象字面量，**数字键是裸写法**（`1:["紫瞳",…]`）不是合法 JSON，
  必须按行首补引号再解析；每行一个条目，所以行首匹配不会误伤标签文本里的数字冒号。
- 标签是**平铺集合**（发色与性格混在一起），CCB 的「角色标签」交集用的就是它；
  上游的分类（发色/发型/瞳色/性格/身份）只服务编辑与筛选 UI，不参与判定。

### 声优 `character_vas`

`subject-characters.jsonlines` **只有 `type`/`order`，没有人物关系**，但归档 dump 另有
`person-characters.jsonlines`（272,836 行）：`{person_id, subject_id, character_id, type, summary}`。

- **必须按作品类型过滤**：只保留 `subjects.type IN (2,4)`（动画 / 游戏），与原版
  `persons.filter(p => p.subject_type === 2 || p.subject_type === 4)` 等价。
- **不得按 `type` 过滤**：实测分布 `{0:252043, 1:177, 2:7427, 3:9484, 4:2080, 5:524, 6:1101}`，
  抽样非零类型分别是 水樹奈々(4) / 押井守(2) / 福山潤(3) / 大塚明夫(1) —— 全部都是配音关系。
- **判定用 `name`（原名），不要用 infobox 中文名**：原版取的是 API 的 `person.name`，
  且同时进 `metaTags` 与 `animeVAs`。人物 infobox 里虽有 `|简体中文名=`（水樹奈々 → 水树奈奈），
  但用它会对不上原版反馈。库里 `name` 与 `name_cn` 各存一列，`name_cn` 仅供 UI 展示。

### 登场作品：**运行时算，不落库**（铁律）

原版 `getCharacterAppearances` 的登场作品集**故意不物化**，由
`infrastructure/CCBCharacterRepository.ts` 用一条联表查询算出来：

```sql
SELECT r.subject_id, r.relation_type, s.type, s.date, s.raw_tags, s.meta_tags, s.score, s.rating_count
FROM character_subject_relations r JOIN subjects s ON s.id = r.subject_id
WHERE r.character_id = ? AND r.relation_type IN (1, 2)
ORDER BY r.subject_id
```

规则（逐条对齐原版）：

- **只收主角/配角**：`relation_type IN (1,2)`（原版 `staff === '主角' || staff === '配角'`）。
- **先按大类过滤、为空则回退全部类型**：`resolveCCBAppearanceTypes(metaTags)`。回退保证了
  只选「书籍/三次元」的房间也能玩，此时**音乐(3) 也会被算进来**，所以 `subjects` 必须含全部类型。
- **丢弃年份无效与未上映的作品**：原版 `if (!details || details.year === null) return null`
  加 `airDate > now` 提前返回。⚠️ 这一步**在标签累积之前**，所以这类作品连标签都不贡献。
- **累积顺序 = `subject_id` 升序**（dump 文件顺序 ≈ 原版 API 的返回顺序），因为标签权重有
  「先算 meta、再算普通标签」的累积依赖；**输出顺序**才是 `rating_count` 降序
  （原版 `.sort((a, b) => b.rating_count - a.rating_count)`，`shared_appearances` 依赖它）。
- **剔除 `nsfw`**：原版客户端里根本没有 `nsfw` 字样，但**本项目一律剔除**（2026-09-18 的合规决定，
  约束以本节为准）：构建期 nsfw 作品不进角色库（关联一并丢弃，且 `subjects_nsfw != 0`
  会让构建失败），运行期 `CCBCharacterRepository` 的抽样与登场作品查询也各带 `nsfw = 0`。
  **注意只剔角色库**：歌曲库保留全集的动画元数据。
- **无法还原 `locked`**：原版会丢弃 `locked` 作品，dump 没有该字段 —— 已知差异。

为什么不物化：它既是 `character_subject_relations × subjects` 的函数，又依赖**房间设置**
（大类过滤），而且算标签权重必需的 `relation_type` 也不在物化表里。
曾经物化过一版 `character_appearances`（还为此把库顶到 343 MiB），已删除。

⚠️ **联表会丢掉 700 行（0.18%）**：这些关联指向 `subject.jsonlines` 里不存在的作品
（dump 内部不一致）。原版不可能遇到 —— API 的 `/characters/{id}/subjects` 只会列出存在的作品。

### 热度 `subjects.heat`（出题排序用）

出题是**两级采样**：先按大类 + 年份区间 + meta 过滤项抽一部作品，再从作品的角色里抽一个。
线上用 `POST /v0/search/subjects` 的 `sort: "heat"` 排序，dump 没有热度字段，因此用收藏分布
`favorite` 五个桶（`wish` / `done` / `doing` / `on_hold` / `dropped`）求和近似 —— 与歌库的
`heat` 同一口径。实测 29,645 部动画里 29,135 部热度 > 0，2010 年抽样前三为
`けいおん！！` / `涼宮ハルヒの消失` / `Angel Beats!`，与直觉一致。

### 标签池**禁止落库**（铁律）

原版的标签池（`metaTags` / `rawTags`）是 `filteredAppearances` 的函数，而 `filteredAppearances`
依赖**房间设置**：`gameSettings.metaTags` 决定 `bigTypes`（默认 `[2]`，选「游戏」→`[4]`、
「书籍」→`[1]`、「三次元」→`[6]`、「全部」→`[1,2,4,6]`，注意是 `else if` 链），再叠加
`subjectTagNum` / `characterTagNum`（原版的 `commonTags` 本地固定为开启，设置里不再提供，与上游互通时照常发 `true`）。**同一个角色在不同设置下标签池不同。**

因此构建脚本只物化**输入**：`subjects.raw_tags`（全类型未过滤的 `{标签: 票数}`）+
`subjects.meta_tags` + `character_subject_relations` + `character_tags` + `character_vas`，
标签累积由运行时的 `infrastructure/CCBCharacterDerivation.ts` 计算，再交给领域反馈判定。
**物化任何一份标签池都是错的**——那会把某一种房间设置写死。

推论：`subjects` 必须包含**全部类型**（含音乐 3），否则「回退到全部类型」那条分支拿不到标签。

### 角色库检索的已知限制

`character_search` 是 **FTS5 trigram**，**查询串短于 3 个字符时必然返回 0 条**
（实测 `牧濑*` 无命中，`牧濑红莉栖*` 命中）。角色名检索必须对 <3 字符的查询回退到
`name / name_cn / aliases` 的 `LIKE` 兜底，否则「牧濑」「LL」这类常见简称搜不到。
注意 `LIKE` 是不区分大小写的子串匹配，会命中 JSON 别名串里的英文片段，需要配合排序/截断。

### CCB 运行时资料与补全边界

- `CCBCharacterWorkerProvider` 是生产查询入口；`CCBCharacterRepository` 的同步 SQLite 查询仅在
  独立 Worker 内执行。最多 64 个在途请求，普通查询最多返回 50 条，作品角色列表最多 100 条；
  单角色关系、全主角采样读取 2001 条用于检查 2000 条硬上限，超限明确失败而不静默截断规则。
- <3 字符使用参数化 `LIKE`，转义 `%`、`_` 与反斜线；较长文本使用带引号的 FTS5 短语。
  别名与 API 补充后的名字参与检索。作品检索覆盖书籍、动画、游戏、三次元，不复用仅动画的歌曲查询。
- 随机出题先按年份、大类、元标签及热度选作品，再按作品关系顺序选主角或前 N 个主配角。
  年榜先选择年份；额外作品保留独立抽样入口；目录模式只读取已导入的成员快照。
  无候选、缺角色、未导入目录分别返回业务错误，不把设置替换成另一套筛选范围。
- `CCBExtraSubjects.json` 登记原版支持外部标签的作品，构建器与运行时共用此唯一列表。
  `character_extra_tags` 仅保存原始作品、角色、分区及标签键的有序关系；不保存 HTML 或房间派生状态。
  构建器默认从原版仓库读取各作品的 JSON，`--extra-tags` 可指定 URL 目录或离线目录；
  文件缺失、分组损坏或全库空标签必须令构建失败。空键表示原版未录入属性，不作为线索导入。
  可见 `appearances` 决定作品数量、评分和年份；`comparisonAppearances` 额外保留登记游戏的主配角
  关系，仅用于共同作品判定。不得把额外关系塞进可见数组，导致跨类型作品计数与评分变化。
  外部标签按判定数组中首个登记作品取值，并沿用同分区、同标签键命中规则；无数据时为空，
  不跳到第二个作品。它们不参与普通标签 BP；仅下发猜测标签及命中结果，不泄漏答案完整标签。
- 图片复用 `enrichment(entity='character', id, payload, fetched_at)` 格式，保存原始 URL，读取时镜像重写。
  `CCBEnrichment` 使用并发 3 的有界队列与相同角色请求合并；429 冷却 5 秒，只有有效响应确实
  无图片或角色 404 才进入 5 分钟内存负缓存。网络、限流、服务端失败与无效响应必须返回明确
  业务错误且可重试；不得用图片降级捕获本地 JSON 损坏或 SQLite 持久化失败。队列闭包也检查
  冷却，避免已入队请求在 429 后继续突发。
- 同次角色头像响应的有效字段存入 `ccb_character_enrichment(id, schema_version, payload, fetched_at)`：
  只接受名字、中文名、别名、简介、有效性别及收藏数与评论数之和，不以缺失或空字段覆盖已有资料。
  这些字段只在后续读取时覆盖基础库；已返回的角色对象不被异步修改。每局角色资料仍由游戏服务
  冻结，不能因头像加载完成改变本局答案、历史猜测或分数。API 不替代本地作品、角色关系、标签或声优。
- 目录仅在用户执行导入时读取 `/v0/indices/{id}/subjects`，每页最多 100 条，总数最多 1000；
  收齐并校验全部分页后原子保存 `ccb_directories`。缺失或受限作品返回 `missingSubjectIds`，
  不为它们联网补抓；分页失败保留之前完整导入结果，禁止保存部分目录。抽题路径绝不请求目录 API。
- 关闭前排空资料请求及持久化任务，再关闭 SQLite；测试使用隔离临时库与注入的网络响应和时钟，
  普通测试及真实本地库小查询不得访问上游。

### 体积

以下是历史构建样本，实际大小和行数以本次构建输出为准，不作为固定验收阈值。

修复 + 新增表后 `bangumi-character.sqlite` 为 **252.8 MiB**（114 MiB 的旧库 → 加 summary/aliases/标签/声优
→ 补 `subjects` 全部类型与 `heat`）：`aliases` 让 trigram 索引显著增长，`subjects` 634,649 行，
`character_subject_relations` 424,143 行（两条索引：按角色、**按作品**——出题 stage 2 要用）。
文本本身不大（`raw_tags` 约 33 MiB / `summary` 23.6 MiB / `aliases` 3.0 MiB / 标签与声优合计约 1.1 MiB）。

⚠️ 历史教训：**曾经物化过标签池（`tag_pool`/`raw_tag_pool`）与登场作品（`character_appearances`），
两样都已被证明是错的并删除**，库一度涨到 343 MiB。判据是同一条 —— 见上一节「登场作品运行时算」
与「标签池禁止落库」。**不要再引入任何「派生结果」列/表。**
**不要给 `character_vas` 加 `(character_id, person_id)` 索引**——主键已是这两列，重复索引白占体积。

## 隐私与协议

`song.bangumi.search` 只返回公开条目摘要；`song.game.submitAnime` 和
`song.game.guessAnime` 只传输 subject ID。当前回合的番剧答案仅在出题人的私有状态、旁观者
私有状态或回合结算摘要中公开，猜测玩家在结算前只能看到自己的猜测记录。

## 排队与截止预算

Bangumi 请求使用有界并发队列，排队、请求和响应体解析共享同一截止预算；超时必须取消排队或在途请求并释放槽位，限流冷却不能留下挂起任务。测试注入请求函数，不访问真实上游。

角色搜索排序先为候选生成一次评分摘要，再由纯比较器排序；比较器不得重复触发补充资料查询。

CCB 图片提示跨键共享有界下载与解码队列，同键合并。排队、读取及解码共用截止预算，取消需释放读取器和解码资源；缓存同时限制条目数与字节数，不能仅依赖输入图片大小限制。

## 猜番映射：抽样探针、数据集补丁与归因

映射规则见上文「番剧题目」，这里只放**测出来的东西**：怎么抽样本、怎么读结果、哪几类失败该往哪修。

### 探针脚本与 dev / test 分离

- 探针在 `.workbuddy/tmp/cold-anime-sample2.ts`（不进仓库）。它直接 import 生产的
  `isSongCandidateMatch` / `hasAnimeSongEvidence` / `scoreAnimeSongCandidate` /
  `buildAlbumQueries` / `albumNameScore`，只在本地复刻**编排顺序**，规则绝不复制一份。
- **测试集必须与开发集「作品级」零重叠**，否则等于拿训练集做推理（实测 dev 93%、
  独立 test 只有 33%）。抽样用 `--exclude <已用样本>` 排除，`--sample-only` 先冻结样本
  再跑，保证多轮之间比的是同一批曲目。
- 分层：`--hot <每类条数> --cold <每类条数>`，热门默认 `heat ≥ 5000`、冷门 `heat < 500`
  （全库 8008 部有曲目的动画里，热门档 1781 部、冷门档 2806 部）。玩家多玩热门番，
  样本要热门略多于冷门。同一部作品每档最多出 1 条，避免被某部番的多条曲目占满。

### 网易云是累积型软限流（读数前必读）

配额吃紧时 cloudsearch **返回空结果而不是报错**，批量探针会把「被限流」误记成
「网易云没有这首歌」（实测同一批样本：单跑成功、60 条批量 `cand=0`）。因此：

- 探针**并发 1 + 条间 2.5s + 空结果退避重试 4s**；判「真没有」之前先单条复测；
- **命中限流就换出口**：`new NeteaseMusicProvider()` = 新伪装 IP + 冷却清零，退避 3s→30s
  再试（Provider 实例自带冷却与 IP，硬打只会让退避涨到 10 分钟）。这是探针能跑完
  上百条的关键 —— 加了它之后 120 条全程零限流错误，冷门档成功率也从 66.7% 回到 87.5%；
- 每条样本记 `rateLimitHits`（命中 `操作频繁 / 405` 的次数），汇总按它把
  「真无候选」与「被限流」分开归因 —— 实测 test 集 20 条 noHit 里相当一部分是限流，
  单条复测立刻命中（如《茶啊二中》「二中中二日记」：批量里 0 候选，单跑搜到
  刘宇宁版本、score 11）。
- **不要为了跑探针而在同一台机器上并发做别的回源**，共用一个限流额度会互相污染。

### noHit 归因的三分法

1. `albums=0`：专辑检索一张都没搜到 → 网易云确实没有这张 CD，无解；
2. `matched=0`：搜到专辑但名称分全部为 0 → 命名差异太大，`albumNameScore` 可加特征词；
3. 有候选却被门禁/验证挡下 → 回查 `isSongTitleMatch` 与 `hasAnimeSongEvidence` 是否过严。

**Bangumi 的条目名经常是整张 CD / 合辑名，而 `relation_type` 仍然写着片头曲 / 片尾曲 /
主题歌**（实测 20 条 noHit 全部如此，如「『VAZZROCK』ユニットソング②」
「アニメ『宇宙戦艦ヤマト2202』オリジナル・サウンドトラック vol.1」「剣勇伝説ヤイバ
ボーカル・コレクション」）。所以「曲名看着像专辑名」不是取错字段 —— 数据源就这么填，
必须靠专辑路径兜底。**不要按条目名像不像单曲来推断条目形态。**

### 多检索词必须并发，验证必须串行

同一条目的多个检索词之间无依赖，`resolveAlbumTrackCandidates` 与
`resolveAnimeLevelCandidates` 都要 `Promise.all` 并行（自动出题是实时链路，串行会把
等待按检索词数量线性放大）；而**候选验证**必须逐首短路，见「出题性能预算」第 1 条。
守卫测试用「闸门探针」：断言最早返回的请求落地时所有检索词都已发出，串行实现立刻变红。

### 「非歌音轨」必须在所有路径否决

曲名门禁有一条「**专辑名 == Bangumi 条目名即放行**」（用来召回挂在整张 CD 下的官方原版），
而 Bangumi 常把**整张特典 CD** 挂成关联曲目——网易云对应专辑里排最前的往往是对白轨。
实测事故：《サイコパス2 第5巻 特典CD》→「ドラマ」、《コードギアス…Sound Episode 1》
→「短編ドラマ…」、《けいおん! バンドやろーよ!! PART2》→「…(Instrumental)」。

- `isNonVocalTrack`（台词 / 广播剧 / 伴奏 / 纯音乐 / 卡拉 OK）在**验证阶段否决**，覆盖全部路径
  （此前的伴奏剔除只做在专辑路径，常规路径只降权不否决），且**不占** `ANIME_TRACK_DETAIL_ATTEMPTS`。
- 与 `isUnplayableAlbumTrack` 分工：后者是专辑路径「选哪首」的粗筛，含现场 / 不插电 / demo /
  器乐改编——这些只是**版本不同**，仍有人声、仍可出题，所以全路径只降权。
- 「ドラマチック / ドラマティック」（dramatic）是正常曲名，正则必须排除，否则误杀。
- 原声带里的**纯编号轨**（`M-815` / `Track 01`）同样没有歌声，一并否决（实测《Dragon Ball Z ヒット曲集》
  被专辑路径匹配到钢琴 BGM 盘，取回首轨即 `M-815`）。

### 番剧级兜底：专辑名含番剧名还不够

`resolveAnimeLevelCandidates` 曾用「专辑名含番剧名」认归属，遇上**泛用名撞车**就错：
动画《Rebirth》(2020) 主题歌实为《Reバース GO!》，却召回同名的《Rebirth》(AMAST&MEDEM)；
1983 年《爱丽丝梦游仙境》被 2013 年粤语同名歌顶掉；《未来日记》被 2026 年的中文同名歌顶掉；
《あした天気になあれ》被 CeVIO 合成音的同名曲顶掉。现要求专辑名**另有发行上下文**
（アニメ / サウンドトラック / 主題歌 / キャラクターソング / 特典 / ソング集 / CD …）。

### 兜底路径不放宽身份（翻唱 / 年代）

`resolveAnimeSong` 里只有**常规检索**路径才允许 `fallbackCover` / `fallbackYear`
（同一个 `allowLooseFallback`）：专辑 / 番剧级兜底已经放宽了「哪首歌」，再放宽
「是不是原版」「是不是同一年代」就会叠出错配 —— 实测《あした天気になあれ》(1984)
被 2026 年的 CeVIO 合成音同名曲顶掉，正是「标题命中该番另一条目 + 年份兜底」叠加的结果。

### 曲名门禁的两处口径必须一致

`isSongTitleMatch` 有截断门槛（候选名更短时需 `≥4` 字且占比 `≥0.6`），
而准入判定用的 `songTitleSimilarity` 原先对任一方向的包含一律给 1 分 ——
《Free!》的角色歌 CD 名里含 `Free`，网易云召回毫不相关的外文歌《Free》(Bling047)，
就靠「被包含 + 番剧上下文命中」凑够证据出了题。两处现共用同一门槛（双 A 面拆段仍放行）。

### 数据集补列与下载

补列（如 `artist`）走**增量补丁脚本只 UPDATE 一列**，别重跑完整构建 —— 后者会用新一版
`id_tags.js` 覆盖线上角色标签（补后 artist 25722/30792，补前为 0）。
`gh release download --pattern "dump-*.zip"` 会命中该 release 的**全部历史 asset**
（实测下 56 个 dump / 约 20GB），必须用精确文件名。
