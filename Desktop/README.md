# BakaGame 桌面壳（Windows / Tauri v2）

CEE 反作弊计划 P2.1–P2.4、P2.7 的桌面端实现。规格原文见
[`tasks/cee-anticheat-plan-2026-10-19.md`](../tasks/cee-anticheat-plan-2026-10-19.md)。

**形态**：Tauri v2 壳 + 远程 URL（`https://game.baka.website`），前端 0 改动、不打包前端产物。
壳里只做三件事——开窗口、跑原生自检、给 ws 握手签名，不含任何业务 UI。
选 Tauri 不选 Electron：release 构建默认没有 DevTools，Rust 侧调 Win32 自然，体积小一个量级。

本目录**不是** pnpm workspace 成员（没动根 `pnpm-workspace.yaml`），构建链完全独立：
只用 `cargo` 与 `@tauri-apps/cli`，不经过 `pnpm --filter`。

---

## 1. 目录结构

```
Desktop/
  README.md                       本文件
  .gitignore                      Rust 构建产物与安装包不进 Git
  src-tauri/
    Cargo.toml                    依赖与打包 profile
    build.rs                      蜜标注入 + 生成 CLIENT_NOTICE.md + tauri-build
    tauri.conf.json               远程 URL 模式配置（无注释，Tauri 的 JSONC 不接受未知键）
    CLIENT_NOTICE.md              完整条款（build.rs 每次构建覆写）
    capabilities/
      default.json                本地窗口 IPC 面
      remote-client-bridge.json   远程 URL 页面的 IPC 面（域名在这里改）
    icons/README.md               图标来源与重新生成命令（五枚图标已入库）
    src/
      main.rs                     入口 + 顶部条款注释块 + 构建身份常量
      lib.rs                      窗口创建、初始化脚本注入、四个命令、启动线程与票据预签
      bridge.rs                   注入页面的 `window.__BAKA_CHANNEL__` 脚本原文
      device.rs                   设备密钥对（DPAPI）+ 注册上报
      attest.rs                   通道证明闭环：领挑战 → 逐字节签名 → 换一次性 ticket
      http.rs                     与服务端共用的 JSON POST 传输层与错误码解析
      selfcheck.rs                六项检测 + 环境探测 + 判定权重
      peb.rs                      PEB InLoadOrderModuleList 遍历
      winapi.rs                   手写最小 Win32 绑定（kernel32 / crypt32 / ntdll 动态解析）
      config.rs                   站点与接口基址、版本号、构建身份
      notice.rs                   `#[used] static CLIENT_NOTICE`（`.rodata`，strings 可读）
```

---

## 2. 构建

### 前置（Windows）

| 需要 | 说明 |
|---|---|
| Rust stable（x86_64-pc-windows-msvc） | `tauri-build` 与 WebView2 绑定都走 MSVC 工具链 |
| Visual Studio Build Tools + Windows SDK | 提供 `link.exe` 与系统头 |
| WebView2 Runtime | 随 Windows 11/Edge 分发；安装包用 `downloadBootstrapper` 兜底 |
| `@tauri-apps/cli` | `pnpm dlx @tauri-apps/cli <命令>`，或 `cargo install tauri-cli --lockfile` |

### 命令

```powershell
cd Desktop\src-tauri

cargo check                              # 只做类型检查（不打包）
pnpm dlx @tauri-apps/cli dev             # 开发运行
pnpm dlx @tauri-apps/cli build           # 打 NSIS 安装包，产物在 target/release/bundle/nsis/
```

`Cargo.lock` 与源码一起进 Git：壳是要发布出去的二进制，锁住整套依赖版本才能让每次构建复现同一份代码。
改完 `Cargo.toml` 要重跑一次 `cargo check` 把 lock 一起更新再提交，否则带 `--locked` 的构建会直接失败。

`tauri dev` 会用 `tauri.conf.json` 里的 `frontendDist`（即远程站点地址）直接加载线上页面，
因此**开发也需要能访问 `https://game.baka.website`**。要改成本地页面调试，得用一个真正
能提供 https 的地址（本地反向代理、或已签发的预览域），例如：

```powershell
$env:BAKA_SITE_URL = "https://<本地反代给出的 https 域>"   # 非 https 会被 config.rs 拒绝并退回默认站点
```

改站点地址同时要去 `capabilities/remote-client-bridge.json` 的 `remote.urls` 加白，
否则桥接能注入但 `sign` / `selfCheck` 会被权限层拒掉。

### 图标（已落地，换 logo 时才需要重做）

`src-tauri/icons/` 里那五枚（32/128/128@2x/`icon.png`/`icon.ico`）按 `tauri.conf.json` 的
`bundle.icon` 命名，源图与 `Client/` 共用 `Client/public/assets/favicon.png`。
重新生成的命令与口径写在 `src-tauri/icons/README.md`。
`tauri build` 在缺图标时会直接失败，这是有意保留的硬门槛。

### 蜜标与构建批次

`build.rs` 每次构建生成 `BKG-CANARY-<buildId>-<random8>`，同时写进：

- 二进制 `.rodata`（`notice.rs` 的 `CLIENT_NOTICE` 与 `BUILD_CANARY`、`main.rs` 的 `BAKA_BUILD_CANARY`）
- `src-tauri/CLIENT_NOTICE.md`

CI 必须显式传两个变量，否则同一发布批次的每个制品标记都不一样，追溯时会误判成多个批次：

```powershell
$env:BAKA_BUILD_ID = "2026-10-21-a"        # 分发批次标识
$env:BAKA_CANARY_RANDOM = "1a7c3f90"       # 8 位十六进制，同批次共用
```

未提供时由短提交号与本机熵派生，只保证「每次构建互不相同」。

---

## 3. 代码签名

壳产物由 Windows Authenticode 签名，签名在打包**之后**做（Tauri 自己不签 Windows 制品）：

```powershell
# 命令示例本身不构成执行授权：证书、时间戳服务与执行时机由发布流程决定
signtool sign /fd SHA256 /tr http://timestamp.digicert.com /td SHA256 `
  .\target\release\bakagame-desktop.exe
signtool sign /fd SHA256 /tr http://timestamp.digicert.com /td SHA256 `
  .\target\release\bundle\nsis\BakaGame_<version>_x64-setup.exe
signtool verify /pa /all <同一个文件>
```

要求：

- **安装包与主 exe 都要签**。只签安装包的话，安装后的 exe 没有签名，
  SmartScreen 与自检的模块白名单都会更难解释。
- 用带时间戳的签名，证书过期后历史制品仍可验。
- 优先 EV/OV 代码签名证书；自签证书只能用于内部测试机。
- 签完再上传 R2，**签名的字节一旦改动蜜标与包体就不对应了**：签名是分发流水线的最后一步。
- 桌面壳的「唯一构建标记」与 Authenticode 是两套独立证据：前者定位构建批次，
  后者只证明制品出自同一发布者。

---

## 4. 分发与强制更新（P2.7）

- **下载入口在首页右上角**（账号左边一枚「下载客户端」）：点开弹窗先选 Windows 还是 Android，
  再把这个平台的**安装包架构、构建日期、文件大小**标出来，玩家看清楚才给下载链。入口本身不写
  反作弊之类的前提——装不装由玩家自己判断。地址与元数据都来自服务端
  `GET /api/client/packages`（逐条说明见 [Agents/ClientChannel.md](../Agents/ClientChannel.md)），
  前端不写死日期与大小；`Client/src/lib/AntiCheatCopy.ts` 里那条常量只剩反作弊错误码文案在用。
- **地址由服务端配置给**：`CLIENT_PACKAGE_WINDOWS_URL` / `CLIENT_PACKAGE_ANDROID_URL`，默认就是下面
  这两条 `cdn.baka.website` 的**固定别名**（不带版本号，永远指向最新，旧链接长期有效）；
  配成空串即从弹窗里去掉该平台。
- **URL 必须带桶名那一段**：`https://cdn.baka.website/files/BakaGame-latest-x64.exe`。加速域按
  「第一段路径当桶名」回源，少了 `/files/` 拿到的是 400 `InvalidBucketName`；带上同一段、对象还没上传时
  回 404 `NoSuchKey`——这说明域名与桶本身是通的，缺的只是产物。发布顺序、缓存策略与验收见
  CI 的 `client-publish` 作业（[.github/workflows/ci.yml](../.github/workflows/ci.yml)）。
- **构建与上传归 CI**：`desktop` 作业打 NSIS 包，`client-publish` 作业把版本化对象与 `latest` 别名推到 R2
  （只改 `Desktop/` 时安卓作业是 skipped，Windows 包照发）。
- **Authenticode 还没接**：CI 产出的安装包没有代码签名证书，用户下载时 SmartScreen 会先拦一道。
  「上传前 `signtool verify`」这一步要等有签名证书再做；它不影响通道证明——壳的「唯一构建标记」与
  Authenticode 是两套独立证据，前者定位构建批次，后者只证明文件没被改过。
- **强制更新**：壳启动注册时上报 `clientVersion`，服务端返回 `minimumVersion`；
  低于最低版本由服务端在握手回 `CLIENT_OUTDATED`，**只拦 `BakaAntiCheat` 房，普通房不受影响**。
  通道证明协议一旦变更必须抬高最低版本，否则旧壳还能继续签名通关。
  最低版本放在服务端配置里，不发版也能紧急抬升。
- **首页软提醒**：壳里打开首页时，前端读 `GET /api/client/update-check` 判断是否过时并浮一条
  可关的提示（记的是「关过哪一档」，抬档后重新出现）。提醒与准入是两件事：不更新照样进普通房，
  反作弊房仍然由服务端硬拦。提示里的「下载最新版」按壳自报的类型给对应平台的包（桌面 exe、
  移动 APK），不再让安卓壳也拿到一条 exe 链接。

---

## 5. 桥接契约（前端与服务端按这个名字对接）

`bridge.rs` 的脚本经 `WebviewWindowBuilder::initialization_script` 注入，
时机是「全局对象已建好、HTML 尚未开始解析」，因此页面脚本执行前 `window.__BAKA_CHANNEL__` 一定存在。

```text
window.__BAKA_CHANNEL__ = {
  clientType: "desktop",           // 固定值
  platform: "windows",             // 固定值
  clientVersion: string,           // 与 Cargo 版本同源
  channelTicket: string,           // 壳签好的一次性票据；没有票时为空串（见下方「通道证明闭环」）
  sign(challenge: string): Promise<string>,   // base64(Ed25519(ASCII challenge 的字节))
  selfCheck(): Promise<SelfCheckReport>,      // { hardFail, softFail, keyProtection }
}
```

- `channelTicket` 是**访问器属性**（`Object.defineProperty` 的 getter），不是普通字符串字段：
  票 30 秒 TTL 且用过即焚，读走一次立刻作废并同步向壳再要一张，第二次读取绝不会返回同一张。
  `Object.freeze` 只锁数据属性的写入，访问器每次读都会重新执行，所以冻结后仍然能给出新票。
- `sign`：签名对象**逐字**是 challenge 这个 ASCII 字符串的字节，不做任何二次编码或加盐；
  返回值是标准 base64（`+` `/` `=`，无换行、无 URL-safe 变换）。服务端按同一口径验签。
- `selfCheck`：每次调用都重跑全部检测，不缓存结果（调试器可能中途才附着）。
- **注入失败就不注入**：拿不到 Tauri IPC、非顶层框架、名字已被占用时保持静默，
  页面按 Web 处理。刻意不注入一个永远 reject 的假通道——那会让桌面用户连普通房都进不去。
- 对象被 `Object.freeze`，属性不可写、不可配置。

### 注册接口（P2.2）

```text
POST {apiBase}/api/client/register
{
  "publicKey":     base64(32 字节 Ed25519 公钥),
  "keyAlgorithm":  "ed25519",
  "clientType":    "desktop",
  "clientVersion": "0.1.0",
  "platform":      "windows",
  "selfCheck":     { "hardFail": [...], "softFail": [...], "keyProtection": "hardware" }
}
→ { "clientId": string, "minimumVersion": string, "outdated": boolean }
```

- `keyAlgorithm` 是服务端 strict schema 的必填枚举（`ed25519` | `ec-p256`），漏了会整次注册被 422。
- `clientId` 缓存在 `%APPDATA%\BakaGame\client\client-id.txt`。
- `clientId` **不在** `__BAKA_CHANNEL__` 里（契约只有上面六个成员，多一个字段就是改协议）。页面若需要它，
  走契约外的 Tauri 命令 `invoke("baka_client_id")`；否则请让服务端在 challenge 帧里带 `clientId`，
  由页面原样回传 —— 两种都要前端配合，本壳不擅自加字段。
- 私钥种子（32 字节）经 DPAPI 当前用户范围加密后存 `%APPDATA%\BakaGame\client\device-key.json`
  （`{ v:1, protection:"dpapi"|"software", key:base64 }`）。
  DPAPI 不可用时**降级**：种子原样 base64 存同一路径，`protection:"software"`，
  `keyProtection` 上报为 `software`，**不拒绝启动**。此时私钥只有用户目录 ACL 这一层保护。
- 离线启动不阻塞：注册失败只记日志，首次 `sign` 调用会按 60 秒节流补一次注册。

### 通道证明闭环（`attest.rs` + `bridge.rs`）

协议原文 [`Agents/ClientChannel.md`](../Agents/ClientChannel.md) §2/§3。注册只解决「这台设备是谁」，
真正让服务端认这条连接的是这三趟往返，全部在 Rust 侧完成，页面只读一个字符串：

```text
1) POST /api/client/challenge   { clientId }
   → { challenge, expiresAt }                        // 挑战 60 秒 TTL、单次消费
2) 用设备私钥对 challenge 的 **ASCII 字节原样** 做 Ed25519 签名
   → base64(64 字节裸签名)                            // 不做任何二次编码、不加盐
3) POST /api/client/attest      { clientId, challenge, signature, clientType, clientVersion, selfCheck }
   → { ticket, expiresAt, outdated }                  // ticket 30 秒 TTL、用过即焚
```

- 第 3 步的 `selfCheck` 每次签发**现跑**（`selfcheck::run`），不复用启动那次结果：调试器可能中途才附着。
- 只重试两类错误：`CHALLENGE_EXPIRED`（重新领一条）与 `CLIENT_UNKNOWN`（按同一把公钥重注册后再来一轮，
  派生规则保证幂等）；一轮最多两次。其余错误（`CLIENT_UNTRUSTED`、`ATTESTATION_REJECTED`…）当场放弃。
- 拿不到票**不报错给玩家**：`channelTicket` 保持空串，页面按网页口径连接，普通房照常，
  反作弊房由服务端拒——与「注入失败就不注入」是同一个取舍。
- 8 秒超时（`attest::HTTP_TIMEOUT`），与注册的 20 秒分开：领取与换票在建连关键路径上。

票的补充时机（`lib.rs`，全部在后台线程，绝不占用导航回调与 IPC 线程）：

| 时机 | 做什么 |
|---|---|
| 启动密钥与 `clientId` 就绪后 | `premint_ticket`：预签一张**没交出去**的票进缓存 |
| 每次允许的导航（`on_navigation`） | 先 `clear_ticket()` 弃票（旧页可能已用掉），再后台预签一张 |
| 页面 `channelTicket` 被读走 | 桥接脚本立刻 `invoke("baka_ticket")` 补签 |
| 桥接脚本每 4 秒轮询 | 手里那张还有用就不问壳要（`force=false`） |
| 页面首次同步读取 | 直接命中缓存里那张预签票，不用现场跑两趟 HTTP |

- 一次性保证：`Ticket::served` 标记 + `take_cached_ticket()` 取出即记为已用；
  `attesting: Mutex<()>` 是串行闸门，避免轮询与导航预签撞成四趟 HTTP。
- 5 秒到期余量（`attest::TICKET_MARGIN_MS`，桥接脚本里的 `TICKET_MARGIN_MS` 必须同值）：
  宁可当没有，也不把「到页面手上才过期」的票交出去。
- 失败退避 10 秒（`TICKET_RETRY_SECONDS`）：离线时轮询不会变成对证明接口的轰炸。

**页面侧还差一步**：`Client/src/lib/BakaChannel.ts` 的 `bakaChannelQuery()` 目前只拼
`clientType` + `clientVersion`，**还没把 `channelTicket` 拼成 `ticket=`**；协议要求握手查询串是
`?clientType=…&clientVersion=…&ticket=…`（服务端 `/api/cee/ws` 读 `ticket` 参数消费）。
本壳已按契约把票准备好，读取是同步的，前端一行就能带上——不在本目录权限范围内，未改。
另有一个前端侧的坑：`Client/src/lib/CEEWs.ts` 在模块加载时就把查询串拼死（`this.path` 在构造函数里定），
重连会复用**同一张已被消费**的票，需要改成每次连接前重新取。

### 自检项词表（`hardFail` / `softFail` 里的取值）

| id | 权重 | 触发条件 |
|---|---|---|
| `debugger_attached` | 硬 | `IsDebuggerPresent` 或 `CheckRemoteDebuggerPresent` 命中 |
| `debug_port` | 硬 | `ProcessDebugPort(7)` 非 0 |
| `debug_object_handle` | 硬 | `ProcessDebugObjectHandle(30)` 返回非空句柄 |
| `debug_query_unavailable` | 硬 | 解析不到 `NtQueryInformationProcess`（正常 Windows 一定有） |
| `module_not_allowed` | 硬 | Toolhelp 枚举到白名单目录外的模块 |
| `module_enumeration_failed` | 硬 | `CreateToolhelp32Snapshot` 失败，无法执行模块检测 |
| `ldr_list_mismatch` | 硬 | PEB `InLoadOrderModuleList` 与 Toolhelp 结果基址集合不一致 |
| `ldr_enumeration_failed` | 硬 | PEB 链遍历失败（截断/成环/读内存失败） |
| `parent_process` | 软 | 父进程不在已知启动器名单内，或父进程名取不到 |
| `devtools` | 软 | 命令行或 `WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS` 里有远程调试参数，或用户数据目录里存在 `DevToolsActivePort`（调试端口真的在监听） |
| `platform_unsupported` | 硬（壳侧） | 非 Windows 构建（绝不当成「已通过」）；服务端按 `mark` 处置，见下方口径说明 |

判定由服务端按这些 id 执行：任一硬失败拒（`CLIENT_UNTRUSTED`）、软失败 ≥2 拒、
软失败 =1 放行并标 `integrity: 'suspect'`；**只有 DPAPI 降级、其余干净 → 放行并标 `keyProtection: 'software'`**。
`keyProtection` 是环境探测，不进任何一条清单。

**口径差已定（2026-10-19）**：服务端把 `platform_unsupported` 归为 `mark` —— 不计分但标
`integrity: 'suspect'`。既满足了本壳「没跑成的检测绝不能当成通过」（记录里看得见，不是 clean），
也没有把它当作弊证据直接拒（非 Windows 构建可能是开发者自己圈的构建）。
要改成硬失败只需在 `Server/src/infrastructure/ClientChannel.ts` 的 `SELF_CHECK_WEIGHTS` 里把它写成
`"hard"`，**别靠改 id 名来解决**：改名等于换协议，两边都得同时抬最低版本。
词表与归类以 `Agents/ClientChannel.md` §4 为准。

新增 id 只能追加，不要改名——服务端与前端按字面量匹配。

模块白名单目录：`%SystemRoot%\System32|SysWOW64|WinSxS`、壳自身安装目录、
WebView2 Runtime 与 Edge 的 `Application` 目录、`Common Files\Microsoft Shared`。
热修追加：`BAKA_MODULE_ALLOWLIST`（分号分隔的路径前缀），抬白名单不需要重新发版。

### 对接现状（2026-10-21 核对，闭环落地后复核）

| 位置 | 状态 |
|---|---|
| `Client/src/lib/BakaChannel.ts` | 字段名与本壳注入的契约**逐字一致**（`clientType` / `platform` / `clientVersion` / `sign` / `selfCheck`）。它只做存在性探测，并把 `clientType` + `clientVersion` 拼进 `/api/cee/ws` 的查询串，**从不调用** `sign` / `selfCheck`，也**还没读 `channelTicket`**。 |
| `Server/src/shared/Model.ts` 的 `ClientChannelProof` | 需要 `clientId` + `keyProtection`，`ConnectionRecord.clientChannel` 由握手填充。 |
| `Server` 的注册接口与验签 | **已实现**：`/api/client/register`、`/api/client/challenge`、`/api/client/attest`（`Server/src/transport/routes/ClientChannelRoutes.ts` + `Server/src/infrastructure/ClientChannel.ts`），握手消费 `ticket`。 |
| 壳侧证明闭环 | **本轮已实现**（`attest.rs`）：注册 → 领挑战 → 签名 → 换票 → 挂到 `channelTicket`。**未编译**（见第 7 节）。 |

剩下两件事都不在本目录权限范围内：

1. **握手带上票**。服务端只认 `/api/cee/ws` 查询串里的 `ticket`，`clientId` 由票在服务端反查，
   前端不需要知道 `clientId`——本壳的 `clientId` 刻意**不进** `__BAKA_CHANNEL__`，
   需要时走契约外命令 `invoke("baka_client_id")`。
2. **`Client` 取票的时机**。`bakaChannelQuery()` 要加 `ticket=` 并在**每次连接前**重新取
   （`CEEWs.ts` 现在在模块加载时把查询串拼死，重连会复用已被消费的票）。
   服务端按本壳自检词表放行：桌面 id 已在 `ClientChannel.ts` 的硬/软失败名单里，
   **新增 id 只能追加、不得改名**。


---

## 6. 数据与隐私面

壳只在注册与每次通道证明时上报：公钥、客户端版本、平台、命中的检测项 id。
**上报内容只有 id，没有任何路径、进程名、命令行原文。**
本地诊断日志默认关闭，只有 `BAKA_DESKTOP_LOG=1` 时才写
`%LOCALAPPDATA%\BakaGame\client\selfcheck.log`，内容仅为时间戳 + 检测项 id + 命中原因，
用于本地排查，不自动上传。`BakaAntiCheat` 关闭时以上任何一项都不影响玩家。

---

## 7. 未验证与未实现（必须如实读这一节）

**编译验证状态**：本机已装 Rust 工具链（`cargo` / `rustc` 1.99，链接走 VS Build Tools 的 MSVC），
`cargo check --all-targets` **通过**，只剩 3 条 dead-code 警告；`Cargo.lock` 已随源码入库。
检查过程中改掉了三处真实编译错误：`ed25519-dalek` 得开 `rand_core` feature 才放开 `SigningKey::generate`、
`Ordering` 不能拿去和 `< 0` 比、`spawn_blocking(...).await` 外面那层 `Ok(...)` 会套出双层 `Result`。
**但没有做过 `tauri build`**（CI 上有打包作业，本机一次也没跑过），也没有真跑过壳，所以以下这些仍逐项待确认：

1. `tauri.conf.json` 各字段与 `capabilities/*.json` 的 schema（尤其 `remote.urls`）是否被本仓库选用的 Tauri 小版本接受
   —— `cargo check` 不读这些 JSON，只有 `tauri build` / `tauri dev` 会校验。
2. `winapi.rs` 三个手写结构体在 x64 上的运行时布局（已有 `PROCESS_BASIC_INFORMATION` 尺寸断言，但断言只在测试里跑）。
3. `attest.rs` / `http.rs` 的**整条闭环从未真跑过**：三趟往返（register / challenge / attest）的字段名与类型
   是照着 `Server/src/transport/routes/ClientChannelRoutes.ts` 的 strict schema 逐项核对出来的，
   没有对线上服务端实际请求过一次。`attest.rs` 里的 `#[test]` 只钉住序列化出来的字段名，不需要网络。
4. `reqwest::blocking` 只能在**非 async 上下文**里用（在 Tokio reactor 线程上构造会 panic）。
   本轮所有调用点都在 `spawn_blocking` 或 `std::thread::spawn` 里；后续改代码不要把 `http::post_json`
   直接挪进 `async fn` 命令体。
5. 票的一次性语义靠壳侧 `Ticket::served` 标记 + 5 秒余量兜住，**没有服务端配合的回归测试**：
   「同一张票被消费两次」「导航后旧票还在」这类问题只有真实握手才能暴露。

**刻意留下的未实现项**（不伪造实现，全部标注 TODO）：

| 项 | 现状 | 缺什么 |
|---|---|---|
| 模块**签名**校验（Authenticode） | 只按路径白名单判定 | `WinVerifyTrust` + `WINTRUST_DATA`/`GUID` 的手写绑定不确定，不敢瞎声明；命中面比路径判定准得多，是下一优先级 |
| WebView2 `AreDevToolsEnabled` 的 COM 读回 | 未实现；改读 `DevToolsActivePort` 文件（通道真的在监听才会写）+ 查远程调试参数，两者任一命中记软失败 | 要读设置位本身需要 `with_webview` 拿 COM `CoreWebView2` 再走 `webview2-com`；依赖版本要与 wry 对齐，本机无法验证 |
| 降级态文件的显式 ACL | 依赖用户目录 ACL | `ConvertStringSecurityDescriptorToSecurityDescriptorW` + `SetFileSecurityW` 的 SDDL 绑定 |
| 强制更新的壳侧拦截 | 只记录 `minimumVersion` 与 `attest` 回传的 `outdated` 并打日志 | 契约里没有可暴露的字段；按「只拦反作弊房」口径由服务端回 `CLIENT_OUTDATED` |
| 移动端 / iOS | 不在本目录范围 | 计划 P3 |

**本目录之外还欠的事**（本轮禁止改已有文件，所以没做）：

- P2.4 要求的五个位置里，仓库根 `AGENTS.md`（已落地）与 `Client/public/llms.txt` 不在 `Desktop/` 内，
  `llms.txt` 那份条款需要另开改动。
- `Desktop/` 要进 pnpm workspace 或加根级脚本转发，需要改 `pnpm-workspace.yaml` 与根 `package.json`。
- 本次实际改了仓库文件，按 [Credits §3](../Agents/Credits.md) 应把模型署名加进
  `Client/src/data/CreditsContent.ts` —— 受「禁止修改已有文件」边界限制未加，需要补一次。
