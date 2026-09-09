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
- 搜索结果缓存 6 小时，条目详情缓存 24 小时；缓存为最多 512 项的 LRU，且相同键的并发请求共享一个 Promise。
- 请求由并发数为 3 的队列调度；上游返回 429 时进入 5 秒冷却、取消等待请求，并返回 `BANGUMI_RATE_LIMITED`。
- 上游非 2xx、返回无效 JSON 或未配置 Provider 时转换为明确的 Bangumi 业务错误。

## 番剧题目

手动出题先搜索条目，再读取详情并从 infobox 提取曲目信息（覆盖 OP、ED、插曲、主题歌、OST、Remix、角色曲、印象曲、同人音乐、Vocaloid、Drama、VOCAL、Radio、Arrange、单曲、精选集、朗读剧、艺人专辑共 18 种曲目类型）。服务端使用提取出的曲名与歌手调用网易云 Provider，选择第一首可播放歌曲作为音频，并基于网易云歌曲、专辑与标签元数据对曲目类型进行智能精准校准；没有曲目信息、没有可播放歌曲或会员权限不足时拒绝提交，并保持当前出题阶段不变。

自动出题支持年份范围、总榜/年榜排名范围与网易云歌曲热度筛选（出题设置移除独立的歌曲类型过滤，默认全量支持所有 18 种曲目）。总榜直接使用 Bangumi 热度排序，年榜会在设置的年份范围内先随机选择一个年份，再按该年份的热度排序取候选作品。候选条目按顺序尝试，歌曲热度不达标时优先继续尝试同一作品的其它曲目，只有该作品所有曲目都不可用时才切换作品；全部失败时返回 `BANGUMI_NO_MUSIC`。

每轮结算摘要呈现与“听歌识曲”对齐的完整歌曲详情卡片（包含封面图、曲名、具体曲目类型徽章如 OP/ED/插曲/OST/Remix/角色曲、歌手与专辑、发行年份、语言、标签、别名与百科简介，彻底消除“其它”模糊分类），并公开番剧最多 5 条作品标签，不公开元标签。

## 隐私与协议

`song.bangumi.search` 只返回公开条目摘要；`song.game.submitAnime` 和
`song.game.guessAnime` 只传输 subject ID。当前回合的番剧答案仅在出题人的私有状态、旁观者
私有状态或回合结算摘要中公开，猜测玩家在结算前只能看到自己的猜测记录。
