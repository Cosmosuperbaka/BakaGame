# Bangumi 数据集与角色资料

涉及 SQLite 数据集构建、作品裁剪、角色标签、声优、登场作品与 CCB 运行时资料时使用本文。图片回填与请求边界见 [BangumiApi](BangumiApi.md)，曲目提取与匹配见 [BangumiSongMatch](BangumiSongMatch.md)。

| 工作范围 | 查阅章节 |
|---|---|
| 构建产物、作品裁剪、表结构 | 「本地数据集构建」 |
| 角色中文名、性别、标签、声优 | 「角色中文名与性别只能从 infobox 解析」「角色标签」「声优」 |
| 登场作品、热度、标签池 | 「登场作品：运行时算，不落库」「热度」「标签池禁止落库」 |
| CCB 检索限制与资料补全 | 「角色库检索的已知限制」「CCB 运行时资料与补全边界」 |
| 体积与索引约束 | 「体积」 |

## 本地数据集构建

`Server/data/bangumi.sqlite` 由 `tools/build_bangumi_db.py` 从 Bangumi Archive dump 生成（**本地一次性
构建**，`tools/` 整体不进 Git）。CI 不构建也不发布数据集；基线（首版）由运维上传——
R2 上保留一份供 CI 的 E2E 取用，服务器则由后端自行更新（角色标签走增量 diff、作品标签与封面地址走
API 刷新、新条目按首播窗口发现）。**角色关系、作品与声优的运行时判定仅使用这些本地数据**；普通角色
查询不得在缺失时回源补查。角色头像及其同次 API 返回的基础资料、用户明确导入的目录成员使用下述独立
补全层。

⚠️ dump 有两个字段不可直接使用：`tags` 被截断为每条 11 个（API 返回 30 个，缺的恰是「鲁路修」这类
有信息量的标签），`images` 整个字段不存在。构建产物必须用 `tools/refresh_subject_tags.py` 全量刷新
一次（作品标签 + `subjects.image`）。

**单库**：猜歌与 CCB 共用同一个数据集文件；`subjects` 只存一份，不得分库——分两处会更新不一致。

| 表 | 内容 | 使用方 |
|---|---|---|
| `subjects` | **裁剪后**的作品（见下）、两侧字段合一、含 `image` 列（dump 无图，留空待后端写） | 双方 |
| `characters` | 角色（全量） | CCB |
| `subject_music_relations` | 动画 ↔ 音乐条目的曲目关系（title / artist / kind） | Songuessr |
| `character_subject_relations` / `character_tags` / `character_extra_tags` / `character_vas` | 角色关系、标签、专属标签、声优 | CCB |

### 作品裁剪口径

**没有角色关联、也没有关联音乐的作品一律不入库** —— 它们既不会出现在 CCB 的登场作品里，
也出不了猜歌的题，却占全库九成以上。

因此 `subjects` 里**没有「数据缺失」这回事**：查不到就是本项目不需要，不是构建漏了。
不得引入 `music_subjects` 或 `music_search`（运行时零读取，曲目信息全部来自 `subject_music_relations`）。

### 角色中文名与性别只能从 infobox 解析（铁律）

归档 dump 的 `character.jsonlines` 字段是
`id / role / name / infobox / summary / comments / collects` —— **没有 `name_cn`，也没有 `gender`**，
两者只能从 `infobox` 里取。而 infobox 是 **wiki 模板原文**，**键前带一个 `|` 前缀**：

```
{{Infobox Crt\r\n|简体中文名= 鲁路修·兰佩路基\r\n|别名={\r\n[L.L.]\r\n[英文名|Lelouch Lamperouge]\r\n}\r\n|性别= 男\r\n…
```

因此解析必须先去 `|` 前缀再匹配。用 `raw.split("=",1)` 与 `"简体中文名"` /
`"性别"` 做**全等比较**会永不命中，导致 `name_cn` 与 `gender` 全库为空且无人发现；同一脚本的音乐路径用
`in` **子串匹配**，所以 `|片头曲` 仍能被命中——「音乐能用、角色不能用」就是这么来的。

配套约定：

- 抽取逻辑集中在 `parse_infobox()` / `parse_character_infobox()` / `normalize_gender()`，
  支持多值块（`别名={` 逐行 `[值]` / `[类型|值]`，取竖线后的值、丢弃空条目）、`[[内链]]` 清洗。
- 性别归一到 `male` / `female` / `?`（非男非女一律 `?`），与 CCB 反馈判定同一口径。
- **必须保留构建期填充率守卫**：`report_character_stats()` 打印全表填充率，且 `name_cn` /
  `gender` / `character_tags` 任一为 **0 直接让构建失败**。缺少守卫时构建会「成功、且没有任何报警」，字段全空也无人发现。
- **必须保留自测**：`tools/test_build_bangumi_db.py`（真实 dump 原文做 fixture + 反例），
  在下载 dump **之前**执行以便快速失败。
- **曲目歌手（`subject_music_relations.artist`）必须在构建期从音乐条目自身的 infobox 解析**：
  `parse_music_infobox_artist()` 同时覆盖单值（`|艺术家= Sound Horizon`）与多值块
  （`|艺术家={` 逐行 `[YOASOBI]`，多艺人时值走 blocks，只读 singles 会整条漏掉）。
  该列**没有别的来源**——`music_subjects` 与 `subject_music_relations` 都不存艺术家，
  一旦落成 `NULL`，`scoreAnimeSongCandidate` 的「歌手交集 +4 / 无交集 −3」整条失效，
  原版优先退化成只看曲名与专辑名。artist 落成 `NULL` 时，唯一带 artist 的 infobox 解析条目
  又可能是负数 id 的伪条目、被 `music_id > 0` 全部过滤 —— 两个缺陷会互相掩护，表现为「猜番经常选到翻唱」。
- **只补列时不要重跑完整构建**：完整构建要读 934MB `subject.jsonlines` 全量载入，还会用
  **新一版** `id_tags.js` 覆盖角色标签（本地重建等于把线上标签换成快照）。补 `artist` 这类
  单列走增量补丁即可（读 dump 建 `{music_id: artist}` 再 `UPDATE ... WHERE music_id > 0`），
  幂等且不触碰标签表。
- `build()` 的产物发布顺序不能改：连接必须在 `Path.replace()` **之前**关闭（Windows 不允许
  重命名仍被打开的文件），且临时目录清理必须 `ignore_errors=True`，否则清理失败抛出的
  `PermissionError` 会把填充率守卫的真实报错整个吞掉。

### 角色标签 `character_tags`（每周自动更新，仓库里不存快照）

上游原版的 `client/src/data/id_tags.js` 是**唯一**可得的标签来源：
原版服务端的 `POST /api/character-tags` 与 `/api/game-character-tags` 都只写 MongoDB，
没有任何读回端点。原版**每周会更新**这个文件，所以**不要把快照提交进本仓库**——存下来必然过期。

链路（日常走增量 diff，全量只用于初始构建与兜底）：

```
CCB-TagsCI  weekly-tags-maintenance        北京时间 周一 04:00
   ├─ 同步 guesser fork → 合并用户反馈标签 → 写 outputs/id_tags.js（提交）
   └─ 同时产出 outputs/id_tags.diff.json（相对上一版的 added/changed/removed）
BakaGame    后端运行时（数据 Worker）       周期执行
   ├─ 拉 outputs/id_tags.diff.json，校验 baseSha256 与本地已应用位点后整组替换 character_tags
   └─ 位点对不上（中间漏过轮次）则拒绝应用，退回「全量 id_tags.js + 全量重建」兜底
```

- **权威地址**：`https://raw.githubusercontent.com/Cosmosuperbaka/CCB-TagsCI/master/outputs/id_tags.js`，
  diff 为同目录的 `outputs/id_tags.diff.json`（注意 CCB-TagsCI 的默认分支是 **`master`**，不是 `main`；
  guesser fork 才是 `main`）。
- **构建脚本也支持直接给 URL**（`--tags` 默认就是这个地址），本地开发不必先手动下载。
- **日常更新只应用 diff**；应用是幂等的，已应用版本记在服务器
  本地状态文件（`appliedSha256`）作为下一轮基线。
- **全量重建只在初始构建或缺轮次补偿时执行**：位点对不上必须走全量（下载 `id_tags.js` + 重建），
  不能拿旧 diff 硬套——会静默漏掉中间的变更。
- 脚本只认结尾 `}` 前的对象字面量，**数字键是裸写法**（`1:["紫瞳",…]`）不是合法 JSON，
  必须按行首补引号再解析；每行一个条目，所以行首匹配不会误伤标签文本里的数字冒号。
- 标签是**平铺集合**（发色与性格混在一起），CCB 的「角色标签」交集用的就是它；
  上游的分类（发色/发型/瞳色/性格/身份）只服务编辑与筛选 UI，不参与判定。

### 声优 `character_vas`

`subject-characters.jsonlines` **只有 `type`/`order`，没有人物关系**，但归档 dump 另有
`person-characters.jsonlines`（272,836 行）：`{person_id, subject_id, character_id, type, summary}`。

- **必须按作品类型过滤**：只保留 `subjects.type IN (2,4)`（动画 / 游戏），与原版
  `persons.filter(p => p.subject_type === 2 || p.subject_type === 4)` 等价。
- **不得按 `type` 过滤**：非零 type 的样本全部都是配音关系（声优 / 导演 / 演员），按 type 过滤会误删。
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
- **剔除 `nsfw`**：原版客户端里根本没有 `nsfw` 字样，但**本项目一律剔除**（合规约束，以本节为准）：构建期 nsfw 作品不进角色库（关联一并丢弃，且 `subjects_nsfw != 0`
  会让构建失败），运行期 `CCBCharacterRepository` 的抽样与登场作品查询也各带 `nsfw = 0`。
  **注意只剔角色库**：歌曲库保留全集的动画元数据。
- **无法还原 `locked`**：原版会丢弃 `locked` 作品，dump 没有该字段 —— 已知差异。

为什么不物化：它既是 `character_subject_relations × subjects` 的函数，又依赖**房间设置**
（大类过滤），而且算标签权重必需的 `relation_type` 也不在物化表里。
不得物化 `character_appearances` 一类的派生表。

⚠️ **联表会丢掉少量行**：这些关联指向 `subject.jsonlines` 里不存在的作品
（dump 内部不一致）。原版不可能遇到 —— API 的 `/characters/{id}/subjects` 只会列出存在的作品。

### 热度 `subjects.heat`（出题排序用）

出题是**两级采样**：先按大类 + 年份区间 + meta 过滤项抽一部作品，再从作品的角色里抽一个。
线上用 `POST /v0/search/subjects` 的 `sort: "heat"` 排序，dump 没有热度字段，因此用收藏分布
`favorite` 五个桶（`wish` / `done` / `doing` / `on_hold` / `dropped`）求和近似 —— 与歌库的
`heat` 同一口径；收藏数近似的排序与线上热度排序一致，可用于出题。

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

`character_search` 是 **FTS5 trigram**，**查询串短于 3 个字符时必然返回 0 条**。角色名检索必须对 <3 字符的查询回退到
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
- 图片复用 `enrichment(entity='character', id, payload, fetched_at)` 格式，保存原始 URL，读取时镜像重写（缓存规则见 [BangumiApi](BangumiApi.md#bangumi-api-回填缓存)）。
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

体积与行数以本次构建输出为准，不作为固定验收阈值；体积增长时先检查是否引入了派生列或重复索引。

⚠️ **不得物化标签池（`tag_pool`/`raw_tag_pool`）或登场作品（`character_appearances`）**：
判据见上一节「登场作品运行时算」与「标签池禁止落库」。**不要再引入任何「派生结果」列/表。**
**不要给 `character_vas` 加 `(character_id, person_id)` 索引**——主键已是这两列，重复索引白占体积。
