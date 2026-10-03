# 网易云音乐 API 使用规范

涉及 `NeteaseMusicProvider`、登录、歌曲请求、缓存或音频行为时使用本文。

| 工作范围 | 查阅章节 |
|---|---|
| 任何真实上游访问 | 「安全与使用边界」「请求、缓存与频率限制」「测试要求」 |
| 扫码登录或凭证失效 | 上述章节及「凭证与出口 IP 必须绑定」「网络兼容参数」 |
| 搜索、歌曲、歌单、歌手、热度 | 「Songuessr 接入约束」与「歌曲筛选」 |
| 歌词、词表、AMLL 或切片 | [SonGuessrLyrics](SonGuessrLyrics.md) 的对应章节 |
| 音频播放与结算 | 「音频播放」 |

## 资料与版本

- API Enhanced 源码：[NeteaseCloudMusicApiEnhanced/api-enhanced](https://github.com/NeteaseCloudMusicApiEnhanced/api-enhanced)
- 在线接口文档：[NeteaseCloudMusicApiEnhanced 文档](https://docs-neteasecloudmusicapi.focalors.ltd/)
- 本项目依赖：`@neteasecloudmusicapienhanced/api`，版本见 `Server/package.json` 与 `Server/bun.lock`。
- API 文档可能存在缓存。核对接口行为时，应同时查看当前锁定依赖版本和 GitHub 最新文档；如果文档版本与代码版本不一致，先清理文档缓存或以锁定依赖的实际导出为准。

## 安全与使用边界

1. 不使用第三方在线 Demo 服务。在线 Demo 仅提供文档示例，不应提交账号、密码、手机号、邮箱或网易云 Cookie；泄露凭据会导致账号被盗。
2. API 项目仅供学习和开发使用。必须尊重版权、服务条款和网易云平台规则，不得用本项目侵犯版权、绕过付费限制或进行滥用流量行为。
3. 生产服务不得从 `Server/.env` 读取网易云 Cookie。正式登录只能由房主在客户端完成，Cookie 只在房间内临时存在于服务端内存，并且不得写入日志、快照、聊天、测试输出或发给其他玩家。
4. `Server/.env` 中的 `NETEASE_COOKIE` 仅供显式运行真实接口测试使用，禁止在应用启动、房间创建或普通测试中读取。该文件不得提交到 Git。已有授权范围内可完成必要的有限验证；没有凭据或授权时先完成 Mock 回归，并报告真实接口未验证。

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

### 凭证与出口 IP 必须绑定

网易云把登录凭证 `MUSIC_U` **绑定在登录当时使用的客户端 IP 上**。出口 IP 在凭证生命周期内漂移，
上游会按异地登录判定，直接返回 `301` / `MUSIC_SESSION_INVALID` —— 表现为「设备还在登录列表里，
但凭证反复失效」。历史上的三重缺陷已全部修复，改动登录链路时**三条都不得回退**：

1. **scope 必须跟随登录会话，而非 cookie 内容**。旧实现按 cookie 字符串哈希取 scope：登录前用的是
   PC 设备字典，登录后变成 `MUSIC_U=...`，两串哈希不同 → 拿到两个不同 IP，**登录态一建立就漂移**。
   现由 `qrLoginScope` 在 `createQrLogin` 时一次性生成并贯穿整条链路。
2. **`login_status` 必须携带 `realIP`**。旧实现在 `getLoginStatus` 里显式传 `randomCNIP=false`，
   完全不发 `realIP`，等于用一个「无 IP」的请求去校验一个「有 IP」的登录态。现改用配置值。
3. **会话结束后必须固化绑定**。`bindSessionIp` 把本会话 IP 写入登录后凭证的 scope，
   使该凭证后续所有请求（搜索、歌曲、歌单、状态校验）继续复用同一个登录 IP。

配套约束：

- `callOptional` 必须与 `call` 一样透传 `randomCNIP` / `includeAnonymousCookie`；历史上它不透传，
  导致设备上报（`uploadDeviceInfo`）脱离登录 IP。
- 设备上报的兜底 EAPI 路径（`createOption` 直调）同样要带 `realIP` 与 `randomCNIP`。
- cookie 对象做 scope 时必须用**键序无关**的稳定序列化（`stableStringify`）；Enhanced API 会给
  cookie 对象补上随机的 `_ntes_nuid` / `NMTID`，用 `JSON.stringify` 会因键序/取值变化算出不同 scope。
- 匿名会话（`register_anonimous`）与公共请求的 IP 独立于登录会话，不得与登录凭证共用 scope。
- **合规边界**：`realIP` 仅用于规避 `460` 出口兼容性问题，不得用于伪造用户来源或绕过风控、
  账号限制、版权限制。生成 IP 必须落在真实 CN 网段内，不得指向具体真实用户的可定位地址。

## Cookie 与客户端边界

BakaGame 由服务端把房主 Cookie 传给 API Enhanced 函数；客户端只收到必要的登录 ACK。浏览器 `credentials: "include"` 仅影响当前浏览器自身凭据，不能用于向其他玩家分发房主 Cookie。

## 网络兼容参数

以下参数必须以当前接口文档和 API 包实际支持情况为准，不得批量、无条件添加：

| 参数 | 作用 | 使用约束 |
| --- | --- | --- |
| `realIP` | 指定服务端识别的客户端 IP，解决部分境外/云出口的 `460` 兼容性问题；请求层据此写入 `X-Real-IP` 与 `X-Forwarded-For` | 只能使用受信任且经过授权的出口地址，不得伪造用户来源或绕过风控。取值必须来自包内 CN 网段库（见下节），不得手工拼接 |
| `randomCNIP=true` | API Enhanced 新版本提供的随机中国 IP 兼容选项 | 仅在文档明确支持的接口和网络兼容场景使用，不得用于规避限流。**它本身不生成 IP**，必须与 `realIP` 同时提供才真正生效 |
| `noCookie=true` | 明确告诉接口本次请求不携带 Cookie | 只有不需要登录态的公开请求使用；登录、账号状态和房主授权请求不得添加 |
| `ua=...` | 指定请求 User-Agent | 只在接口或兼容性确实要求时设置，保持值可审计，不得伪装成任意第三方客户端 |

示例（仅表示文档参数形式，不能照抄到所有接口）：

```text
/song/url?id=...&randomCNIP=true
/api/song/detail?id=...&noCookie=true
/api/song/detail?id=...&ua=Mozilla/5.0
```

### CN 出口 IP 生成：唯一真相源是包内网段库

`randomCNIP` 只是开关，真正的伪装出口 IP 由我们自己生成并通过 `realIP` 下发。**禁止再手工拼接 IP 段**
（历史实现按 `116.25–94.x.x` 随机拼接，并不保证落在真实 CN 网段，会被上游判定为异常来源）：

- 真相源为依赖包自带的 `node_modules/@neteasecloudmusicapienhanced/api/data/china_ip_ranges.txt`
  （4147 条真实 CIDR），由 `parseChinaIpRanges` 解析、`randomChineseIp` 按区间权重抽段后段内随机。
- **刻意不 import 包内 `util/index.js`**：该模块顶层 `require('./logger')`，每次生成都会向 stdout 打印
  带 ANSI 色的 `[INFO] Generated Random Chinese IP: ...`，污染本项目结构化日志；读取数据文件是零副作用的等价实现。
  这与「禁止为屏蔽第三方开发日志而改写全局 `console.log`」是同一条约束的两面。
- 数据文件缺失或损坏时必须回退到内置兜底网段，**不得抛错导致完全无法出网**。
- 校验方式：`readChinaIpRanges()` + `randomChineseIp()` 已导出，测试需断言生成结果 100% 落在网段内（当前回归取 2000 次采样）。

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
- 登录：仅支持二维码登录，并使用 `login_status` 校验登录状态。创建二维码与扫码轮询采用官方 PC 客户端契约（`os: "pc"`, `channel: "netease"`, `appver: "3.1.29.205117"`, `User-Agent: NeteaseMusicDesktop/...`），并携带自定义 `deviceName`（默认 `BakaGame`）。**整条链路（`login_qr_key` → `login_qr_create` → `login_qr_check` → `deviceinfo_center_upload` → `login_status`）必须共用同一个出口 IP**，详见上文「凭证与出口 IP 必须绑定」。
- 设备名称上报：网易云官方 PC 客户端登录后，设备管理列表展示的是当前系统用户名而非 `"pc"`。其底层机制是在登录成功后通过 EAPI 向 `/api/deviceinfo/center/upload` 发送 `{ deviceName }` 上报设备信息。`NeteaseMusicProvider` 在 `checkQrLogin` 授权成功后自动调用 `uploadDeviceInfo` 执行相同上报，确保网易云设备管理中心稳定展示自定义名称 `BakaGame`。

播放地址优先使用稳定的 `song_url`，`song_url_v1` 作为后备。当前 API Enhanced 版本的 `song_url_v1` 可能抛出 `xeapi public key is missing`，不能只判断函数是否存在后直接调用。播放 URL 在服务端统一转换为 HTTPS，避免 HTTPS 页面被混合内容策略拦截。
- **全局音乐解灰 (General Unblock)**：默认开启（支持通过环境变量 `ENABLE_GENERAL_UNBLOCK=true|false` 或 provider 选项 `enableGeneralUnblock` 控制）。针对网易云官方未提供播放地址（`!url`）、返回试听片段（`freeTrialInfo != null`）或返回 404 等受限状态的歌曲，自动触发多级跨平台音源解灰（优先调用 API 模块的 `song_url_match`，回退至 `song_url_v1` 携带 `unblock: "true"`；只使用 API 包公开接口，不直接导入其传递依赖），取得的音频地址经 HTTPS 规范化后写入缓存，确保无 VIP 凭据或版权受限歌曲也能正常获取完整音频。
- **解灰音源必须显式指定 `source`，并校验结果不是「伪解灰」**。公开匹配接口不传 `source` 时按 `unblockmusic-utils/modules` 目录的字母序尝试，`bugpk` 恰好排在最前；它对没有自有音源的歌曲会返回网易云官方外链 `/song/media/outer/url?id=X.mp3`，字符串非空所以被判为「解灰成功」，还会短路掉后面真正可用的音源。该外链对受限歌曲只会 302 到下载页 HTML（`content-type: text/html`），播放器必然报错。因此 `unblockSongAudio` 固定按 `UNBLOCK_SOURCE_ORDER`（`unm` 最前、`bugpk` 最后）逐个音源调用，并拒收一切指回 `music.163.com/song/media/outer/url` 的结果，继续尝试下一个音源；全部失败才抛 `SONG_UNAVAILABLE`。改动音源顺序或新增音源时必须保留该校验。典型症状：服务端日志打出「网易云歌曲解灰成功」而客户端随即上报 `song.game.audioFailed`。
- **解灰必须带超时上界，并且要吃掉超时之后才到达的拒绝**。第三方音源存在「请求被丢弃、返回的 Promise 永不 settle」的情况（实测约每 5~10 次一遇）。没有上界时 `getSong` 会永远挂起，自动出题随即永久停在 `automaticRoundLoading`：房间再也开不了下一轮，而客户端对长任务发的是 `timeout: 0`，连超时提示都不会有。`unblockSongAudio` 因此对每个音源套一层 `settleWithin`（默认单源 4s、单次解灰总预算 12s，可用 `unblockSourceTimeoutMs` / `unblockTotalBudgetMs` 覆盖），总预算用 `now()` 判定，用尽即停手。**用 `Promise.race` 加超时必须同时给原 Promise 挂 `catch`**：它在超时之后才拒绝时若没有处理器就是 unhandledRejection，而 **Bun 会直接终止整个进程**（实测 exit=1）。
- **验证「这首歌能不能播」必须看总量或时长，不能只看 HTTP 200/206**。实测无 Cookie 拉取 `requiresVip` 会员曲：未解灰时同样返回 `206 + audio/mpeg`，但总量恒约 481 KB，正是 **30 秒 @128 kbps 的试听片段**（按整曲时长折算等效码率只有 13~19 kbps）；解灰成功后才拿到 320 kbps 整曲，总字节与 `durationMs` 严格自洽。因此「`audioUrl` 非空」「Range 请求 206」「`content-type` 是 audio」三条都**不能**作为可播放判据，唯一判据是**总字节 ÷ 时长**落在正常码率区间。推论：`isRestricted` 必须继续依赖 `freeTrialInfo != null`，不得因为「反正有 url」就跳过解灰；VIP 曲目对非会员账号的解灰能力是真实有效的，不是伪成功。
  `loadAudioUrl` 因此有一条硬性实现约束：**拿到 `freeTrialInfo` 时不得把官方 url 当作可用地址**——它把 `audioUrl` 置空，解灰成功才写入整曲地址，解灰失败就让 `getSong` 抛 `SONG_UNAVAILABLE`。绝不回退返回试听片段，否则片段会被当成可出题的音频静默进局。账号的会员状态**不参与**出题可用性判定，选曲链路也不得按 `requiresVip` 预剔除候选（细则见 [BangumiApi](BangumiApi.md) 的出题链路规则）。
- 副歌接口使用 `song_chorus`（调用 `/api/song/chorus`），返回毫秒级的 `startTime` 与 `endTime`。若上游无副歌数据或返回空数组，系统平滑降级为无副歌信息，由客户端回退到整曲起始位置。

### 服务会话与异步结果归属

- 房间音乐认证采用「最新请求意图获胜」：Cookie 校验和二维码轮询在发起前占有认证操作标识，返回后复核房间对象、当前标识、连接席位及房主；清除账号、显式离房和房主变更使旧认证失效，迟到结果不得恢复或覆盖账号。开局复验只能更新其开始时捕获的同一会话，不能清除后来安装的账号。
- 自动开局与下一轮在安装回合前复核当前操作、阶段及调用归属；返回等待撤销旧准备操作。失败回滚及 finally 释放加载锁也只属于原操作，不能恢复已结束的答案页或解除新操作的锁。
- 猜歌、猜番校验期间明确拒绝放弃（`GUESS_IN_PROGRESS`），两种题型共用同一互斥语义；异步校验失败仍按既有规则补偿预占配额。
- 房间设置先在副本中完成元信息、密码和题目筛选校验，再整体提交；拒绝的设置不得改变房名、可见性、旁观权限、密码或游戏设置。
- 猜番候选解析仅对 `SONG_UNAVAILABLE` / `SONG_NOT_FOUND` 继续尝试，空匹配仍可换曲目；音乐依赖限流、会话失效及其它全局失败原样透传（保留错误 details），不能降级成「没有关联歌曲」或继续下一番剧。
- 音频准备与答题使用独立时钟：安装回合时设置 15 秒准备宽限；全体未就绪时巡检在宽限后强制进入可答态，不扣配额。首个真正或强制就绪时才锚定答题/硬截止，保留完整答题窗口；聊天续活不能延长回合硬截止。

### 服务端缓存策略

- 公共歌曲数据按不带 Cookie 的键共享缓存，Cookie 只参与需要登录态的歌单请求和播放地址请求；Cookie 经过摘要后才进入缓存键，原文不会写入缓存或日志。
- 默认缓存上限为 512 条且总估算大小不超过 32 MiB，使用 LRU 淘汰；条目同时记录命中次数和业务优先级，便于空闲维护时优先保留常用数据。部署方可通过 `cacheMaxEntries`、`cacheMaxBytes` 调整上限。
- 默认 TTL 按数据稳定性区分：搜索、歌单、热度 6 小时；歌曲元数据、歌词、歌手歌曲 24 小时；百科和副歌 3 天。播放地址单独按 Cookie 缓存 10 分钟，避免把授权态或易失效 URL 共享给其他请求。
- 条目在 TTL 的 80% 进入软过期，命中时返回旧值并尝试后台刷新；TTL 的 3 倍为硬过期，超过后必须重新请求。后台刷新仅在请求队列空闲且未处于限流冷却期时执行，并复用同一键的 `inFlight` 请求，避免多人并发重复入队。
- 连续 30 分钟没有用户主动音乐请求时暂停预刷新，并清理低命中且长期未访问的条目及失效刷新引用；缓存仍受条目数和字节上限约束，不会因长 TTL 无限增长。
- `undefined` 和空结果默认也会按对应 TTL 缓存，用于稳定表示“上游暂时没有该数据”，避免短时间内反复请求。
- **例外：可重试成功的取值不得缓存空结果**。播放地址（`audio` 命名空间）显式传 `cacheNegative: false`，
  取到空地址时不写缓存、直接抛出 `SONG_UNAVAILABLE`，下次请求重新回源。
  理由：播放地址取决于上游实时授权态，一次抖动返回的空值若落缓存，就会被钉死整个 10 分钟 TTL，
  玩家表现为「这首歌永远加载不出来」，且与出题随机性无关的偶发抖动会被放大成长期故障。
  判据是「重试可能成功」：副歌、百科、元数据这类**上游确实没有该数据**的空结果照旧缓存，不可混为一谈。
- 浏览器报告播放地址失效时，客户端发送 `song.game.audioFailed`。服务端删除该 Cookie 作用域的旧 URL，强制请求一次新地址并广播最新房间快照；新地址仍不可用时才向前端返回音乐错误。

### 歌词与播放器

获取优先级、清洗判定、切片时间轴、AMLL 排版及动画统一见 [SonGuessrLyrics](SonGuessrLyrics.md)。修改歌词代码时读取对应章节；登录、搜索与缓存任务不需要通读播放器细则。

### 音频播放

- 浏览器不显示原生 `<audio controls>`，用户不能拖动当前片段。
- **竞猜阶段**：音频加载完成后自动开始播放；播放期间不提供暂停、拖动或进度控制，播放到歌词片段结束后才允许使用歌词区域右上角的方形“重播音频”按钮。
- **结算阶段**：进入 `roundResult` 阶段后，由 `roundSummary` 透传答案歌曲的 `audioUrl` 与 `chorus`。客户端自动从副歌起点（`chorus.startTime`，缺失时为 0）起播，播放至副歌终点（`chorus.endTime`，缺失时为整曲结束）。结算卡片保持简洁紧凑，不展示副歌时间徽章与播放/暂停控制按钮；客户端全局常驻单例 `<audio>` 并在切台与前台恢复时自动同步音量，防止切台原生重播或音量失控。
- 若浏览器的自动播放策略拦截开始播放，显示手动播放/重播后备按钮，不得恢复原生音频进度控件。
- 音频加载必须监听至少 `canplay`、`loadeddata` 和 `error`，并设置超时与重试入口；不能只依赖 `canplaythrough`。
- 音频资源必须使用 HTTPS 且支持 Range。**`<audio>` 元素严禁声明 `crossOrigin`**：声明后浏览器会按 CORS 模式拉取媒体，而解灰音源（kuwo 等）不返回 `Access-Control-Allow-Origin`，请求直接被判 `net::ERR_FAILED`（症状：服务端日志打出「解灰成功」而客户端立刻 `song.game.audioFailed`，网络面板里该请求瞬间 failed）。不声明 `crossOrigin` 的媒体元素本就不受 CORS 约束，且全站没有任何 Web Audio / `createMediaElementSource` 用法，因此该属性纯属多余。注意网易云官方 CDN 带 ACAO，官方歌曲即使声明了也照常播放——不要据此认为该属性是必需的。守卫测试见 `Client/src/pages/SonGuessrRoomPage.test.tsx` 对 audio 节点的断言。

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

## 歌曲筛选

- 歌单读取使用 `playlist_track_all`（缺少时回退 `playlist_detail`），客户端可提交网易云歌单数字 ID 或链接，服务端只保存规范化后的数字 ID。
- **歌单必须翻页取完，不得只取单页**：`playlist_track_all` 单页上限 1000 首，按 `offset` 以 `PLAYLIST_PAGE_SIZE` 步进翻页，按曲目 ID 去重，`PLAYLIST_MAX_PAGES` 兜底。`playlist_detail` 不支持 `offset`（每页返回同一份 `tracks`），终止条件用「本页是否带来新曲目」，否则会重复整页；翻页失败只结束翻页、保留已取到的曲目，不得丢弃整个歌单。实测固定 `limit: 1000, offset: 0` 时 1200 首歌单尾部 200 首永远进不了题库。
- 歌手搜索使用 `cloudsearch` 的 `type=100`，歌手歌曲使用 `artist_songs`（缺少时回退 `artist_top_song`）。多个歌手在歌手筛选组内取并集，再与歌单、热度条件取交集。
- 红心数使用 `song_red_count` 的 `data.count`，不要使用歌曲详情中的 `pop`（它是另一种热度指标）。`countDesc` 可能只显示 `100w+` 等近似文本，但 `count` 仍是服务端筛选使用的数值。
- 热度筛选档位固定为 `0`、`1000`、`10000`、`100000`。自动出题选中候选后仍需调用 `song_detail` 获取歌词、音频和百科信息。
- 三个筛选项均为可选；歌单、歌手都未配置时，自动出题默认使用热歌榜歌单 `3778678` 作为题库，再应用红心数条件。

### 歌词回源与清洗边界

- AMLL 回源使用独立有界队列；搜索和下载共享截止预算，同键合并请求。网络超时、服务端错误等瞬态失败不能写入长期缺失缓存。
- 角色、独唱与说唱等正文优先于署名启发式，不能因关键词删除正文。告警保留结构化错误、堆栈与原因，仍遵守遥测脱敏。
