# 网易云音乐 API 使用规范

本文档记录网易云音乐 API Enhanced 的官方资料、图片中的接口注意事项，以及
BakaGame Songuessr 的实际接入约束。所有后续修改
`Server/src/infrastructure/NeteaseMusicProvider.ts` 或 Songuessr 音乐请求时，必须先阅读本文档。

## 资料与版本

- API Enhanced 源码：[NeteaseCloudMusicApiEnhanced/api-enhanced](https://github.com/NeteaseCloudMusicApiEnhanced/api-enhanced)
- 在线接口文档：[NeteaseCloudMusicApiEnhanced 文档](https://docs-neteasecloudmusicapi.focalors.ltd/)
- 本项目依赖：`@neteasecloudmusicapienhanced/api`，版本见 `Server/package.json` 与 `Server/bun.lock`。
- API 文档可能存在缓存。核对接口行为时，应同时查看当前锁定依赖版本和 GitHub 最新文档；如果文档版本与代码版本不一致，先清理文档缓存或以锁定依赖的实际导出为准。

## 安全与使用边界

1. 不使用第三方在线 Demo 服务。在线 Demo 仅提供文档示例，不应提交账号、密码、手机号、邮箱或网易云 Cookie；泄露凭据会导致账号被盗。
2. API 项目仅供学习和开发使用。必须尊重版权、服务条款和网易云平台规则，不得用本项目侵犯版权、绕过付费限制或进行滥用流量行为。
3. 生产服务不得从 `Server/.env` 读取网易云 Cookie。正式登录只能由房主在客户端完成，Cookie 只在房间内临时存在于服务端内存，并且不得写入日志、快照、聊天、测试输出或发给其他玩家。
4. `Server/.env` 中的 `NETEASE_COOKIE` 仅供显式运行真实接口测试使用，禁止在应用启动、房间创建或普通测试中读取。该文件不得提交到 Git。

## 请求、缓存与频率限制

### GET、POST 与时间戳

- 文档示例通常同时支持 GET 和 POST；使用 POST 时必须按接口要求携带时间戳。
- 对同一 URL 的重复请求可能命中约两分钟缓存；如果请求 URL 完全相同，API 服务可能在两分钟内只向网易云上游请求一次。
- 需要绕过某个不应缓存的接口时，按文档在 URL 后增加时间戳或其他无意义查询参数，使 URL 唯一。不要对登录接口、搜索接口和播放地址接口无条件追加随机参数，否则会破坏缓存并提高触发限流的概率。
- 本项目优先复用 API Enhanced 包的函数，不自行拼装请求 URL。只有确认接口需要绕过缓存时，才在对应调用点加入明确的、可测试的缓存策略。

### 登录与重复请求

- 不要高频重复调用登录接口。登录成功后复用得到的 Cookie 和账号状态，直到服务端返回登录失效。
- 接口返回 `301` 通常表示未登录或登录状态未被正确带上；如果刚刚登录仍返回 `301`，先等待约两分钟或使用符合文档的唯一 URL 再检查一次，不要立即循环登录。
- 反复调用部分接口可能触发网易云的频率控制，返回 `503 Service Unavailable` 或类似“IP 高频错误”。生产环境应依靠反向代理、合理缓存和请求合并解决；不要通过无限重试放大请求。
- 某些海外网络或部分云服务器可能返回 `460 cheating`。可使用受信任的境内出口或代理池解决网络可达性，但不得用代理池规避账号、版权或频率限制。

## Cookie、请求头与客户端

直接调用 HTTP API 时，若接口需要登录态，按文档把 Cookie 放在请求参数或 Cookie 请求头中，并确保浏览器跨域请求显式携带凭据：

```ts
// axios
axios.get(url, { withCredentials: true });

// fetch
fetch(url, { credentials: "include" });
```

图片示例还展示了 `xhrFields: { withCredentials: true }`。这只适用于确实拥有对应 Cookie 的请求方；不得把房主 Cookie 注入其他玩家浏览器。BakaGame 的实际实现由服务端将房主 Cookie 传给 API Enhanced 函数，客户端只收到必要的登录 ACK。

## 网络兼容参数

以下参数必须以当前接口文档和 API 包实际支持情况为准，不得批量、无条件添加：

| 参数 | 作用 | 使用约束 |
| --- | --- | --- |
| `realIP` | 指定服务端识别的客户端 IP，解决部分境外/云出口的 `460` 兼容性问题 | 只能使用受信任且经过授权的出口地址，不得伪造用户来源或绕过风控 |
| `randomCNIP=true` | API Enhanced 新版本提供的随机中国 IP 兼容选项 | 仅在文档明确支持的接口和网络兼容场景使用，不得用于规避限流 |
| `noCookie=true` | 明确告诉接口本次请求不携带 Cookie | 只有不需要登录态的公开请求使用；登录、账号状态和房主授权请求不得添加 |
| `ua=...` | 指定请求 User-Agent | 只在接口或兼容性确实要求时设置，保持值可审计，不得伪装成任意第三方客户端 |

示例（仅表示文档参数形式，不能照抄到所有接口）：

```text
/song/url?id=...&randomCNIP=true
/api/song/detail?id=...&noCookie=true
/api/song/detail?id=...&ua=Mozilla/5.0
```

### 图片缩放

网易云图片 URL 支持在查询参数中使用 `param=宽y高`（例如 `?param=50y50`）缩放图片。优先在展示层按需缩放，不要把大尺寸原图无上限地广播或缓存；用户头像和专辑图应设置合理的尺寸、超时和错误占位。

### 分页

分页接口返回 `more: true` 时表示仍有下一页。调用方必须根据接口要求递增 `offset`/页码并设置上限，不能因为 `more` 无限请求。Songuessr 搜索结果应限制单次数量，避免把整张歌单或搜索结果推送给客户端。

## Songuessr 接入约束

### 请求链路

所有歌曲相关请求都经过 `NeteaseMusicProvider`：

- 搜索：`cloudsearch`/`search`。
- 出题歌曲详情：`song_detail`、时间轴歌词、播放地址、可选歌曲百科以及副歌时间（`song_chorus`）。
- 猜测歌曲：只读取元数据，不请求歌词或音频。
- 登录：仅支持二维码登录，并使用 `login_status` 校验登录状态。创建二维码与扫码轮询采用官方 PC 客户端契约（`os: "pc"`, `channel: "netease"`, `appver: "3.1.29.205117"`, `User-Agent: NeteaseMusicDesktop/...`），并携带自定义 `deviceName`（默认 `BakaGame`）。
- 设备名称上报：网易云官方 PC 客户端登录后，设备管理列表展示的是当前系统用户名而非 `"pc"`。其底层机制是在登录成功后通过 EAPI 向 `/api/deviceinfo/center/upload` 发送 `{ deviceName }` 上报设备信息。`NeteaseMusicProvider` 在 `checkQrLogin` 授权成功后自动调用 `uploadDeviceInfo` 执行相同上报，确保网易云设备管理中心稳定展示自定义名称 `BakaGame`。

播放地址优先使用稳定的 `song_url`，`song_url_v1` 作为后备。当前 API Enhanced 版本的 `song_url_v1` 可能抛出 `xeapi public key is missing`，不能只判断函数是否存在后直接调用。播放 URL 在服务端统一转换为 HTTPS，避免 HTTPS 页面被混合内容策略拦截。
副歌接口使用 `song_chorus`（调用 `/api/song/chorus`），返回毫秒级的 `startTime` 与 `endTime`。若上游无副歌数据或返回空数组，系统平滑降级为无副歌信息，由客户端回退到整曲起始位置。

### 服务端缓存策略

- 公共歌曲数据按不带 Cookie 的键共享缓存，Cookie 只参与需要登录态的歌单请求和播放地址请求；Cookie 经过摘要后才进入缓存键，原文不会写入缓存或日志。
- 默认缓存上限为 512 条且总估算大小不超过 32 MiB，使用 LRU 淘汰；条目同时记录命中次数和业务优先级，便于空闲维护时优先保留常用数据。部署方可通过 `cacheMaxEntries`、`cacheMaxBytes` 调整上限。
- 默认 TTL 按数据稳定性区分：搜索、歌单、热度 6 小时；歌曲元数据、歌词、歌手歌曲 24 小时；百科和副歌 3 天。播放地址单独按 Cookie 缓存 10 分钟，避免把授权态或易失效 URL 共享给其他请求。
- 条目在 TTL 的 80% 进入软过期，命中时返回旧值并尝试后台刷新；TTL 的 3 倍为硬过期，超过后必须重新请求。后台刷新仅在请求队列空闲且未处于限流冷却期时执行，并复用同一键的 `inFlight` 请求，避免多人并发重复入队。
- 连续 30 分钟没有用户主动音乐请求时暂停预刷新，并清理低命中且长期未访问的条目及失效刷新引用；缓存仍受条目数和字节上限约束，不会因长 TTL 无限增长。
- `undefined` 和空结果也会按对应 TTL 缓存，用于稳定表示“上游暂时没有该数据”，避免短时间内反复请求。
- 浏览器报告播放地址失效时，客户端发送 `song.game.audioFailed`。服务端删除该 Cookie 作用域的旧 URL，强制请求一次新地址并广播最新房间快照；新地址仍不可用时才向前端返回音乐错误。

### 歌词清洗

时间轴歌词进入游戏前必须：

- 解析多时间戳 LRC，并重新计算每句结束时间。
- 删除歌名、歌手、专辑名等标题行。
- 删除中文和英文作词、作曲、编曲、制作、录音、混音、母带、乐器演奏及发行署名行，包括 `Production Coordination`、`Keyboards & Programming`、`Drums`、`Strings Arranged & Conducted`、`Recorded at`、`Engineered by` 等变体。
- 过滤后的歌词行数达到设置要求时，交给 `createSongLyricClip` 选择连续歌词片段；单句跨度超过 12 秒的候选片段必须跳过，避免截取过长间奏。
- 歌词缺失或过滤后的行数不足时，允许纯音乐或未上传歌词的歌曲出题，改为在歌曲时长内随机截取 `设置歌词行数 * 6` 秒的音频片段。
- 竞猜阶段当前歌曲为纯音乐或无歌词时，标题更正显示为“音乐片段”，内容区域提示“当前歌曲为纯音乐或无歌词”，避免误导玩家为房间关闭歌词显示。

### 音频播放

- 浏览器不显示原生 `<audio controls>`，用户不能拖动当前片段。
- **竞猜阶段**：音频加载完成后自动开始播放；播放期间不提供暂停、拖动或进度控制，播放到歌词片段结束后才允许使用歌词区域右上角的方形“重播音频”按钮。
- **结算阶段**：进入 `roundResult` 阶段后，由 `roundSummary` 透传答案歌曲的 `audioUrl` 与 `chorus`。客户端自动从副歌起点（`chorus.startTime`，缺失时为 0）起播，播放至副歌终点（`chorus.endTime`，缺失时为整曲结束）。结算卡片保持简洁紧凑，不展示副歌时间徽章与播放/暂停控制按钮；客户端全局常驻单例 `<audio>` 并在切台与前台恢复时自动同步音量，防止切台原生重播或音量失控。
- 若浏览器的自动播放策略拦截开始播放，显示手动播放/重播后备按钮，不得恢复原生音频进度控件。
- 音频加载必须监听至少 `canplay`、`loadeddata` 和 `error`，并设置超时与重试入口；不能只依赖 `canplaythrough`。
- 音频资源必须使用 HTTPS、支持 Range，并在浏览器端满足 CORS 要求。

## 测试要求

- 常规 `bun test` 使用 mock API，不访问网易云，不读取 Cookie，保证离线、快速、可重复。
- 真实接口测试单独运行：

  ```bash
  cd Server
  bun run test:music:real
  ```

- 真实测试从本地 `.env` 读取 `NETEASE_COOKIE`，验证登录状态、搜索、歌曲详情、时间轴歌词、HTTPS 播放地址、Range/CORS 和真实制作人员过滤；测试输出不得打印 Cookie、账号资料或完整响应。
- 真实接口测试可能受网易云缓存、网络出口、账号权限和上游限流影响。失败时先查看状态码和接口文档，禁止通过无限重试或批量更换 IP“修复”测试。
- 新增或修改音乐接口时，至少补充一条 mock 回归测试和一条真实接口测试断言；如果接口不适合真实测试，应在文档中记录原因和替代验证方式。
- 歌单读取使用 `playlist_track_all`（缺少时回退 `playlist_detail`），客户端可提交网易云歌单数字 ID 或链接，服务端只保存规范化后的数字 ID。
- 歌手搜索使用 `cloudsearch` 的 `type=100`，歌手歌曲使用 `artist_songs`（缺少时回退 `artist_top_song`）。多个歌手在歌手筛选组内取并集，再与歌单、热度条件取交集。
- 红心数使用 `song_red_count` 的 `data.count`，不要使用歌曲详情中的 `pop`（它是另一种热度指标）。`countDesc` 可能只显示 `100w+` 等近似文本，但 `count` 仍是服务端筛选使用的数值。
- 热度筛选档位固定为 `0`、`1000`、`10000`、`100000`。自动出题选中候选后仍需调用 `song_detail` 获取歌词、音频和百科信息。
- 三个筛选项均为可选；歌单、歌手都未配置时，自动出题默认使用热歌榜歌单 `3778678` 作为题库，再应用红心数条件。
