# Songuessr Bangumi 接入规范

听歌猜番使用 Bangumi 条目作为答案，服务端负责所有 Bangumi 网络请求。客户端只通过
`/api/songuessr/ws` 对应的 WebSocket 命令搜索条目和提交 subject ID，不直接访问 Bangumi
接口，也不接触原始图片域名。

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
3. **原版优先排序**：通过门禁的候选歌先经 `scoreAnimeSongCandidate` 打分降序排列再依次验证可播放性。评分以曲名相似度为基础，歌手与 Bangumi 记录有交集时加权，命中翻唱、伴奏、纯音乐、现场等非原唱标记时降权。网易云会把翻唱、伴奏版本混排在原版之前，此排序确保原版存在时不被翻唱版抢占；仅能召回翻唱版时仍正常出题，不因缺少原版而失败。
4. **近期题目防重缓冲**：房间维护最近 10 轮的近期番剧 ID（`recentSubjectIds`）与近期歌曲 ID（`recentSongIds`）滑动窗口。自动出题和曲目解析优先避让近期出题历史，杜绝连续多轮抽中同一部番或同一首歌。

选择第一首满足匹配度门禁且可播放的歌曲作为音频（按上述原版优先顺序取首个），并基于网易云歌曲、专辑与标签元数据对曲目类型进行智能精准校准；没有曲目信息、没有可播放歌曲或会员权限不足时拒绝提交，并保持当前出题阶段不变。

**曲目类型校准以歌曲自身标注为准（必须遵守）**：Bangumi 关联条目的分类常比歌曲自身标注更粗——官方 MV、单曲碟会被归到「其他 → 主题曲」，片尾曲的专辑条目也可能挂在「插入歌」下。因此当歌曲元数据（曲名 / 专辑 / 标签）里明确写着片头曲 / 片尾曲 / 插入歌时，**必须以歌曲标注为准确认类型**，优先级高于 Bangumi 的粗分类，否则会出现「片尾曲的歌配着插曲徽章」这类错配。判定统一走共享导出函数 `detectExplicitTrackKind`（`Server/src/shared/SonGuessr.ts`）——服务端 `refineTrackKind` 与客户端结算徽章 `formatTrackKind` 共用同一真相源，严禁各写一套正则。该函数只认可带「曲 / 歌 / テーマ」后缀或完整英文单词（`opening` / `ending` / `insert song`）的写法，避免把普通歌名里偶然出现的 `in`、`ed` 片段误判成插入歌或片尾曲；歌曲无显式标注时保留 Bangumi 原分类。

**曲目类型只在结算摘要公开**：出题阶段的房间快照 `currentRound` 只有 `roundNumber` / `submitterPlayerId` / `audioUrl` / `lyricClip`，**不含 `song` 与 `animeTrack`**；`animeTrack.kind` 仅随 `roundSummary`（回合结算）下发。校验曲目类型的测试与功能必须走「出题 → 结算」路径，不能从出题快照读取。

自动出题支持年份范围、总榜/年榜排名范围与网易云歌曲热度筛选（出题设置移除独立的歌曲类型过滤，默认全量支持所有 18 种曲目）。总榜直接使用 Bangumi 热度排序，年榜会在设置的年份范围内先随机选择一个年份，再按该年份的热度排序取候选作品。候选条目按顺序尝试并避让近期番剧，歌曲热度不达标时优先继续尝试同一作品的其它曲目，只有该作品所有曲目都不可用时才切换作品；全部失败时返回 `BANGUMI_NO_MUSIC`。

每轮结算摘要呈现与“听歌识曲”对齐的完整歌曲详情卡片（包含封面图、曲名、具体曲目类型徽章如 OP/ED/插曲/OST/Remix/角色曲、歌手与专辑、发行年份、语言、标签、别名与百科简介，彻底消除“其它”模糊分类），并公开番剧最多 5 条作品标签，不公开元标签。

## 隐私与协议

`song.bangumi.search` 只返回公开条目摘要；`song.game.submitAnime` 和
`song.game.guessAnime` 只传输 subject ID。当前回合的番剧答案仅在出题人的私有状态、旁观者
私有状态或回合结算摘要中公开，猜测玩家在结算前只能看到自己的猜测记录。
