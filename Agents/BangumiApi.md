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
原始图片地址；配置后，服务端只重写主机名为 `lain.bgm.tv` 的 HTTPS 图片链接。重写结果
使用镜像源和原链接的 pathname、query、hash，其他主机名和无效 URL 原样返回。

## 请求边界

Bangumi 请求统一由 `Server/src/infrastructure/BangumiProvider.ts` 发起：

- `POST /v0/search/subjects` 用于条目搜索和自动出题筛选，查询类型固定为动画（type 2）。
- `GET /v0/subjects/{id}` 用于读取条目详情、图片、评分、标签和 infobox。
- 搜索结果缓存 6 小时，条目详情缓存 24 小时；相同键的并发请求共享一个 Promise。
- 同时最多执行 3 个请求；上游返回 429 时进入 5 秒冷却并返回 `BANGUMI_RATE_LIMITED`。
- 上游非 2xx、返回无效 JSON 或未配置 Provider 时转换为明确的 Bangumi 业务错误。

## 番剧题目

手动出题先搜索条目，再读取详情并从 infobox 提取片头曲、片尾曲、插入曲和主题歌。服务端
使用提取出的曲名与歌手调用网易云 Provider，选择第一首可播放歌曲作为音频；没有曲目信息、
没有可播放歌曲或会员权限不足时拒绝提交，并保持当前出题阶段不变。

自动出题支持年份、最低评分、最低评分人数、标签、元标签、目录 ID 和自定义 subject ID
筛选。候选条目按顺序尝试，跳过没有可播放关联歌曲的条目，全部失败时返回
`BANGUMI_NO_MUSIC`。

## 隐私与协议

`song.bangumi.search` 只返回公开条目摘要；`song.game.submitAnime` 和
`song.game.guessAnime` 只传输 subject ID。当前回合的番剧答案仅在出题人的私有状态、旁观者
私有状态或回合结算摘要中公开，猜测玩家在结算前只能看到自己的猜测记录。

