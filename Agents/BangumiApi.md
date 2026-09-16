# Bangumi 接入与数据集规范

听歌猜番使用 Bangumi 条目作为答案，服务端负责所有 Bangumi 网络请求。客户端只通过
`/api/songuessr/ws` 对应的 WebSocket 命令搜索条目和提交 subject ID，不直接访问 Bangumi
接口，也不接触原始图片域名。

CCB（猜动漫角色）复用同一份本地数据集与镜像配置，角色数据见文末「本地数据集构建」。

## 配置

在 `Server/.env` 配置：

```bash
BANGUMI_API_URL=https://api.bgm.tv
BANGUMI_IMAGE_URL=
```

`BANGUMI_API_URL` 应指向兼容 Bangumi v0 API 的镜像。`BANGUMI_IMAGE_URL` 为空时保留
原始图片地址；配置后，服务端只重写主机名为 `lain.bgm.tv` 的图片链接。重写结果
使用镜像源和原链接的 pathname、query、hash，其他主机名和无效 URL 原样返回。

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
1. **限定检索策略**：在没有明确歌手信息时，检索关键词自动附加番剧原名与中文译名（如 `${track.title} ${anime.name}`），消除重名歌曲干扰。曲目带有歌手信息时，除 `${track.title} ${track.artist}` 外仍会追加番剧原名、中文译名与纯曲名宽检索，避免 Bangumi 与网易云的歌手写法差异导致原版漏召回、只剩翻唱版可匹配。
2. **歌名匹配度门禁**：采用 `isSongTitleMatch` 校验网易云返回歌曲标题与 Bangumi 曲名（规范化并剥离 `(TV Size)` 等版本后缀），拒绝与目标曲名不符的异形搜索结果。
3. **曲名命中或专辑名命中**：候选必须与曲目相关，判定为「曲名命中」（`isSongTitleMatch`）**或**「专辑名与曲目名完全一致」（`isSongAlbumMatch`，共享导出）。专辑名命中是**必需的第三条召回通道**：Bangumi 会把整张原声带挂成一条关联曲目（曲目名 = 专辑名，如《君の名は。》），官方原声带里真正的曲目（`前前前世` / `スパークル`…）只有专辑名能命中，而按曲名检索只能召回同名器乐改编（实测帝玖管弦乐团《交响组曲「君の名は。」》顶掉了官方原版）。
4. **原版优先排序**：通过门禁的候选歌先经 `scoreAnimeSongCandidate` 打分降序排列再依次验证可播放性，评分维度固定为五项：
   - 曲名相似度：完全一致 2 / 包含 1；
   - **专辑名与曲目名完全一致 +2**：原唱原版通常发行在同名专辑/单曲里（YOASOBI《勇者》的专辑名就是《勇者》），同名翻唱挂在《勇者-葬送的芙莉莲OP》这类自建合辑下，曲名并列时专辑名是唯一能区分原版的免费信号；
   - 歌手与 Bangumi 记录有交集 +4 / 无交集 -3（Bangumi 未记录歌手时不参与加减分）；
   - 命中非原唱标记降权：翻唱 -5、伴奏/纯音乐/现场等 -4、**器乐改编 -5**（交响 / 管弦 / 钢琴 / 演奏 / `arrange` / 八音盒 等二次演绎）；
   - 标记词**只在 Bangumi 曲目自身没有该标记时生效**，避免把题面本身就是 Cover / Arrange / Remix 的曲目所有候选一起降权（等同随机）。
   网易云会把翻唱、器乐改编版本混排在原版之前，此排序确保原版存在时不被抢占；仅能召回翻唱版时仍正常出题，不因缺少原版而失败。
5. **近期题目防重缓冲**：房间维护最近 10 轮的近期番剧 ID（`recentSubjectIds`）与近期歌曲 ID（`recentSongIds`）滑动窗口。自动出题和曲目解析优先避让近期出题历史，杜绝连续多轮抽中同一部番或同一首歌。

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
2. **可在检索结果判定的过滤必须前置**：非会员房间里 `requiresVip` 的候选必然装不上回合，必须先用检索结果带出的 `fee` 标记剔除，严禁「先 `getSong` 再丢弃」。热度门槛无法由检索结果判定，退一步用一次廉价的红心数查询（`song_red_count`）先判掉，避免为一个必然被否决的候选拉取歌词与音频。
3. **长任务不得设客户端请求超时**：`song.game.start` 与 `song.game.nextRound` 的耗时由上游决定，客户端必须以 `timeout: 0` 发送（见 `WebsocketClient.send`），并在等待期间每 3 秒 `song.room.requestSync` 同步一次房间状态。**严禁用默认 10 秒请求超时**：那只会制造「后端还在选曲、前端已提示失败」的假失败。


**曲目池必须先剔除版权署名伪条目（必须遵守）**：Bangumi 关联条目里混有大量**并非歌曲**的署名占位行——版权方、制作委员会、动画师/作家署名，如 `©BanG Dream! Project`、`©SUNRISE`、`©Visual Art's`、`（C）2006 SUNRISE inc.`、`Ⓒ 創通・タツノコプロ`、`時をかける少女」製作委員会2006`。它们在本地数据集 `subject_music_relations` 中 `music_id` 为**负数**（实测全库 7762 条），却被归到 `opening` 类目，因 `KIND_PRIORITY.opening = 1` 而排在所有真实曲目之前。

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
每周一 03:30 由 `.github/workflows/bangumi-data.yml` 重建并提交（LFS）。**它们是运行时唯一的数据源，
服务端不做在线爬取**。

| 文件 | 内容 | 使用方 |
|---|---|---|
| `bangumi-song.sqlite` | `subjects`（动画）/ `music_subjects` / `subject_music_relations` | Songuessr |
| `bangumi-character.sqlite` | `characters` / `subjects` / `character_subject_relations` / `character_tags` / `character_vas` | CCB |

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
- `build()` 的产物发布顺序不能改：连接必须在 `Path.replace()` **之前**关闭（Windows 不允许
  重命名仍被打开的文件），且临时目录清理必须 `ignore_errors=True`，否则清理失败抛出的
  `PermissionError` 会把填充率守卫的真实报错整个吞掉。

### 角色标签 `character_tags`

上游 CCB 的 `client/src/data/id_tags.js`（**32705 角色 / 421 标签**）是**唯一**可得的标签快照：
原版服务端的 `POST /api/character-tags` 与 `/api/game-character-tags` 都是只写 MongoDB 的
收集口，没有任何读回端点。

- 中间产物 `tools/data/character-tags.json`（标签字典 + 索引数组，876 KiB，**普通 git 文件、不进 LFS**），
  由 `tools/import_character_tags.py` 生成。放 `tools/data/` 是因为它是**构建输入**，
  服务端运行时不需要；且 `Server/data/` 只放 LFS 产物（`.gitattributes` 只标 `*.sqlite`）。
- 更新标签：`python3 tools/import_character_tags.py <id_tags.js> tools/data/character-tags.json`。
  取上游仓库的 `client/src/data/id_tags.js`（421 标签）而不是 `CCBFilter/dump` 里的旧快照（372 标签）。
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

### 角色库检索的已知限制

`character_search` 是 **FTS5 trigram**，**查询串短于 3 个字符时必然返回 0 条**
（实测 `牧濑*` 无命中，`牧濑红莉栖*` 命中）。角色名检索必须对 <3 字符的查询回退到
`name / name_cn / aliases` 的 `LIKE` 兜底，否则「牧濑」「LL」这类常见简称搜不到。
注意 `LIKE` 是不区分大小写的子串匹配，会命中 JSON 别名串里的英文片段，需要配合排序/截断。

### 体积

修复 + 新增表后 `bangumi-character.sqlite` 明显变大（旧 dump 实测 114 MiB → 228 MiB），
主要来自 `summary` 列、`aliases` 让 trigram 索引显著增长，以及两张新表。
文本本身很小（summary 23.6 MiB / aliases 3.0 MiB / 标签与声优合计约 1.1 MiB）。
**不要给 `character_vas` 加 `(character_id, person_id)` 索引**——主键已是这两列，重复索引白占体积。

## 隐私与协议

`song.bangumi.search` 只返回公开条目摘要；`song.game.submitAnime` 和
`song.game.guessAnime` 只传输 subject ID。当前回合的番剧答案仅在出题人的私有状态、旁观者
私有状态或回合结算摘要中公开，猜测玩家在结算前只能看到自己的猜测记录。
