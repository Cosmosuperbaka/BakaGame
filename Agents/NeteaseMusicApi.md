# 网易云音乐 API 使用规范

本文档记录网易云音乐 API Enhanced 的官方资料、图片中的接口注意事项，以及
BakaGame Song Guessr 的实际接入约束。所有后续修改
`Server/src/infrastructure/netease-music-provider.ts` 或 Song Guessr 音乐请求时，必须先阅读本文档。

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

分页接口返回 `more: true` 时表示仍有下一页。调用方必须根据接口要求递增 `offset`/页码并设置上限，不能因为 `more` 无限请求。Song Guessr 搜索结果应限制单次数量，避免把整张歌单或搜索结果推送给客户端。

## Song Guessr 接入约束

### 请求链路

所有歌曲相关请求都经过 `NeteaseMusicProvider`：

- 搜索：`cloudsearch`/`search`。
- 出题歌曲详情：`song_detail`、时间轴歌词、播放地址和可选歌曲百科。
- 猜测歌曲：只读取元数据，不请求歌词或音频。
- 登录：二维码、手机验证码/密码、邮箱密码和 `login_status`。

播放地址优先使用稳定的 `song_url`，`song_url_v1` 作为后备。当前 API Enhanced 版本的 `song_url_v1` 可能抛出 `xeapi public key is missing`，不能只判断函数是否存在后直接调用。播放 URL 在服务端统一转换为 HTTPS，避免 HTTPS 页面被混合内容策略拦截。

### 歌词清洗

时间轴歌词进入游戏前必须：

- 解析多时间戳 LRC，并重新计算每句结束时间。
- 删除歌名、歌手、专辑名等标题行。
- 删除中文和英文作词、作曲、编曲、制作、录音、混音、母带、乐器演奏及发行署名行，包括 `Production Coordination`、`Keyboards & Programming`、`Drums`、`Strings Arranged & Conducted`、`Recorded at`、`Engineered by` 等变体。
- 过滤后的歌词行数不足时返回可预期的业务错误，不能把空歌词交给 `createSongLyricClip`。

### 音频播放

- 浏览器不显示原生 `<audio controls>`，用户不能暂停、拖动或跳过当前片段。
- 音频加载完成后自动开始播放；播放期间不提供暂停、拖动或进度控制，播放到歌词片段结束后才允许使用歌词区域右上角的方形“重播片段”按钮。
- 若浏览器的自动播放策略拦截开始播放，只显示同一位置的小型播放后备按钮，不得恢复原生音频进度控件。
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
