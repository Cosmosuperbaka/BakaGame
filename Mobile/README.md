# BakaGame 移动端 Android 壳（Capacitor）

CEE 反作弊计划 P3 的客户端部分：Capacitor 壳 + **内嵌** `Client/` 构建产物 + `BakaChannel` 原生插件。
与桌面端（远程 URL）不同，移动端必须打包产物（商店审核 + 离线可用）。UI 全部复用 `Client/`，
前端只有 `bridge/baka-bridge.js` 一处桥接，`Client/` 源码零改动。本期不做 iOS；协议 `clientType: "mobile"` 不区分平台。

## 1. 桥接契约（逐字，前端/服务端按此对接）

注入到页面全局：

```ts
window.__BAKA_CHANNEL__ = {
  clientType: "mobile",
  platform: "android",
  clientVersion: string,                       // 打包时注入，与 APK versionName 同源
  channelTicket: string,                       // 桥接层签好的一次性票据；无票时为空串（见第 3 节）
  sign(challenge: string): Promise<string>,    // base64(DER ECDSA P-256 SHA-256)
  selfCheck(): Promise<SelfCheckReport>,
}
type SelfCheckReport = {
  hardFail: string[]
  softFail: string[]
  attestationLevel: "trusted" | "degraded" | "rejected"
}
```

`clientVersion` 单一版本源是 `Mobile/package.json` 的 `version`：`scripts/prepare-web.mjs`
同时替换桥接占位符与 `android/app/build.gradle` 的 `versionName`。发版只改这一处。
`selfCheck()` 的 `attestationLevel` 取自原生 `SelfCheck.check()`，只是壳内展示用的档位，准入判定在服务端。

`channelTicket` 与桌面壳同构：它是**只读访问器属性**（`Object.defineProperty` 的 getter），
不是普通字符串字段——票一次性，读走即作废并补签，见第 3 节。

## 2. 交给服务端的材料与字段名（服务端验证链由服务端仓库实现）

服务端 `POST /api/client/register` 的 schema 是 **strict 的（`additionalProperties: false`）**：
只接受下面六个键，**多一个键整次请求被 422**。所以注册现在只上报公钥与档位，
链的材料留在本机（见下方「暂未上报」列）。

首次要票 / 首次 `sign()` 前，桥接层懒执行一次注册（`fetch` 绝对地址 + `credentials: "include"`，
复用壳内已登录的账号会话）：

`POST /api/client/register`，JSON body：

| 字段 | 类型 | 说明 |
|---|---|---|
| `clientType` | `"mobile"` | 固定 |
| `platform` | `"android"` | 固定（本期无 iOS） |
| `clientVersion` | string | 与 `__BAKA_CHANNEL__.clientVersion` 一致 |
| `publicKey` | string | base64(X.509 SubjectPublicKeyInfo DER)，EC P-256 |
| `keyAlgorithm` | `"ec-p256"` | **协议 §3 词表取值**；服务端按它选验签分支（ec = DER 签名 + SHA256）。签名哈希算法在服务端同一分支里固定，不进字段名 |
| `selfCheck` | object | `{ hardFail, softFail, attestationLevel }`，每个 id 限长 64，桥接层 `clampIds` 兜住 |
| `attestation` | object \| 缺省 | `{ attestationChallenge, chain }`，`chain` 是 PEM 数组（叶子在前，最多 8 张）；原生给不出链时整个字段不发 |

响应期望 `{ clientId }`（或 `{ data: { clientId } }`，桥接层两者都接受），
`clientId` 存 `localStorage` 的 `baka.channel.clientId`。

**链只发一次**：`getKeyInfo` 另外返回 `attestationChallenge`（base64 16 字节 nonce）、
`keyAttestationChain`（**完整 attestation 证书链，PEM，叶子在前**）、`packageName`
（`website.baka.game`）、`strongBox`。桥接层只把 `attestationChallenge` + `keyAttestationChain`
发进 `attestation`——包名与签名摘要由服务端从链里的 `attestationApplicationId` 读，
不接受客户端自报。服务端验完把档位记进设备表，之后每次握手只签挑战，不再重发链。

`selfCheck.attestationLevel` 是壳本地解析扩展的展示值：服务端一旦验过链就用自家结论覆盖它。

服务端验证要点（实现提醒，全部在服务端）：双根内置（旧根 + 2026-02 新根）、CRL 缓存容忍拉取失败、
2021 年前工厂证书过期放行、RKP 到期换证属正常、`attestationChallenge` 与扩展 nonce 核对、
`attestationApplicationId` 与 `packageName` + 签名摘要核对。**同一密钥长期复用，只做一次链验证。**

## 3. 通道证明闭环（`bridge/baka-bridge.js`）

协议原文 [`Agents/ClientChannel.md`](../Agents/ClientChannel.md) §2/§3。
与桌面端的区别：**桌面壳在 Rust 里跑，移动端在桥接 JS 里跑**，原生插件只出密钥能力
（`getKeyInfo` / `sign` / `selfCheck`），不碰接口、不持有票据。

```text
1) POST /api/client/challenge   { clientId }
   → { challenge, expiresAt }                     // 挑战 60 秒 TTL、单次消费
2) plugin.sign({ challenge })                     // Keystore 对 challenge 的原样 UTF-8 字节
   → base64(DER SEQUENCE{r,s} ECDSA-P256-SHA256)   // 不做任何二次编码
3) POST /api/client/attest      { clientId, challenge, signature, clientType, clientVersion, selfCheck }
   → { ticket, expiresAt, outdated }               // ticket 30 秒 TTL、用过即焚
```

- `channelTicket` 是**访问器属性**：读一次立刻作废并同步补签一张；之后每 4 秒轮询补票，
  保证页面任何时候同步读取（`bakaChannelQuery()`）都握着一张没用过、也没到期的票。
- 到期余量 5 秒（`TICKET_MARGIN_MS`），与桌面壳 `attest::TICKET_MARGIN_MS` 同值。
- 失败退避 10 秒（`TICKET_RETRY_MS`）：离线时轮询与页面读取都不会变成对证明接口的轰炸。
- **注册依旧惰性**：定时器只在页面第一次要票时才启动；此前壳启动不产生任何接口流量。
- `CLIENT_UNKNOWN`（服务端换库/清理过设备表）时清掉本地 `clientId`，下一轮强制重新注册（按公钥派生，天然幂等）。
- 签不出票**不报错给玩家**：`channelTicket` 保持空串，页面按 Web 口径连接，普通房照常。
- 壳被切回前台（`visibilitychange`）时立刻补一张——后台里定时器会被系统节流，票基本早就凉了。

接口基址：内嵌产物的相对路径会打到 Capacitor 自己的 `https://localhost`，所以三趟往返**必须显式打绝对地址**。
默认 `https://game.baka.website`，可由页面 `window.__BAKA_API_BASE__` 覆盖，**只接受 https**
（与桌面壳 `config.rs` 同口径：不给「把签名发到假站」留口子）。

## 4. selfCheck 事实码

判定规则沿用桌面端口径：`hardFail` 任一 → 拒进 `BakaAntiCheat` 房（`CLIENT_UNTRUSTED`）；
`softFail ≥ 2` → 拒；`= 1` 放行并标记 `integrity: 'suspect'`。**服务端是最终判定方**，
`attestationLevel` 是客户端解析扩展的展示值，仅供参考（服务端验过链之后用自己的结论覆盖它）。

服务端按**冒号前的前缀**匹配 `Server/src/infrastructure/ClientChannel.ts` 的 `SELF_CHECK_WEIGHTS`，
后缀（包名、su 路径）只进日志；未登记的前缀失败关闭 = 拒。所以下表**新增一项必须同步服务端**，
否则正常设备直接进不了房。词表与归类以 `Agents/ClientChannel.md` §4 为准。

| 码 | 档位 | 含义 |
|---|---|---|
| `accessibility_automation:<id>` | hard | 启用中的无障碍服务命中自动化黑名单（Auto.js/按键精灵/触动精灵等） |
| `accessibility_unknown:<id>` | soft | 非白名单无障碍服务。**未知一律 soft，不 hard**，避免误伤读屏用户 |
| `root_su:<path>` / `root_test_keys` / `root_debuggable` / `root_magisk:<path>` / `root_magisk_mount` | hard | Root / Magisk / test-keys |
| `emulator_build` / `emulator_qemu` / `emulator_no_accelerometer` | hard | 模拟器特征（Build props、ro.kernel.qemu、无加速度计） |
| `abi_x86` / `emulator_no_gyroscope` | soft | x86 ABI、缺陀螺仪（存在真实低端机，不硬拒） |
| `media_projection_active` / `media_projection_allowed` | soft | 录屏 best-effort 探测（见下方局限） |
| `clone_source_path` / `clone_user_data` | hard | APK 路径不属于自身包（多开框架宿主路径特征） |
| `clone_user_id` / `clone_data_dir` | soft | 非 0 用户（工作资料会命中）/ 数据目录异常 |
| `keystore_unavailable` | hard | AndroidKeyStore 不可用，sign 无从谈起 |
| `accessibility_check_failed` | soft | 检测本身异常 |

**录屏检测的诚实局限**：Android 8+ 不允许枚举其它应用的 MediaProjection 服务，
真正兜住「截屏 OCR / 录屏外传」的是 MainActivity 里恒定设置的 `FLAG_SECURE`（系统级把本窗口采集变黑屏），
`SelfCheck` 的相关项只是 best-effort 加分。无障碍白名单必须随设备反馈持续维护，新增条目需人工核实来源
（见 `SelfCheck.kt` 注释）。

## 5. 目录

```
Mobile/
├── package.json            # 独立 npm 包，不在根 pnpm workspace 成员内
├── capacitor.config.ts     # webDir=dist-web（内嵌产物），不做远程 URL
├── bridge/baka-bridge.js   # 唯一前端桥接：四成员契约 + 注册 + 通道证明闭环（challenge/sign/attest）
├── scripts/prepare-web.mjs # Client/dist → dist-web + 注入桥接 + 版本同步
├── scripts/apk.mjs         # Gradle 定位（wrapper / PATH / ~/.gradle 缓存）并跑构建
└── android/                # 手写最小工程（等效 cap add android 产物，未跑过 CLI）
    ├── settings.gradle / build.gradle / gradle.properties
    ├── app/build.gradle / src/main/AndroidManifest.xml
    └── app/src/main/java/website/baka/game/
        ├── MainActivity.kt              # FLAG_SECURE + 注册插件
        └── channel/
            ├── BakaChannelPlugin.kt     # getKeyInfo / sign / selfCheck
            ├── KeystoreChannel.kt       # KeyStore EC P-256 + attestation
            ├── AttestationLocal.kt      # OID 1.3.6.1.4.1.11129.2.1.17 本地最小解析（仅展示）
            └── SelfCheck.kt             # P3.3 运行时检测
```

## 6. 构建步骤

前置：JDK 17/21（**本机默认 JDK 25 与 AGP 8.7 未验证兼容**，出问题用
`android/gradle.properties` 里注释掉的 `org.gradle.java.home` 指定）；Android SDK
（本机在 `D:\AndroidSdk`，需设 `ANDROID_HOME` 或让 Studio 写 `android/local.properties`）；
Gradle 8.9+（本机 `~/.gradle` 已缓存 8.14.3，`apk.mjs` 会自动命中，可离线复用）。

```bash
# 0.（一次性）生成 Gradle wrapper：用 Android Studio 打开 Mobile/android/，
#    或在有 gradle 的终端执行 `cd Mobile/android && gradle wrapper`
# 1. 依赖安装（本包不在 pnpm workspace，用 npm）
cd Mobile && npm install
# 2. 出前端产物并打包进壳
pnpm --filter client build          # 仓库根执行
npm run prepare-web                 # 生成 Mobile/dist-web（含桥接注入）
npm run sync                        # cap sync android：dist-web → android assets
# 3. 构建
npm run apk -- assembleDebug        # 调试包；assembleRelease 为未签名包
#    产物：android/app/build/outputs/apk/<variant>/BakaGame-<version>-<variant>.apk
```

注意：`cap sync` 会重写 `android/app/src/main/assets/public/`，该目录与
`capacitor.config.json` 属生成物（已在 `.gitignore`）；`prepare-web` 必须在 `sync` 之前跑，
顺序颠倒会丢桥接脚本。

## 7. 签名与商店分发成本

- **调试**：默认 debug keystore 即可上手。
- **正式签名**：`build.gradle` 的 `signingConfigs` 留空。密钥库放 `Mobile/keystore/`
  （已 gitignore，绝不入库），口令走 CI secret；`assembleRelease` 后配 `signingConfig` 出可安装 AAB/APK。
- **应用商店**：国内各安卓商店上架需软著/营业执照等资质与逐店审核，是 P3 最高的固定成本（计划 §6 已提示）；
  Google Play 走 AAB + Play App Signing。发布节奏：桥接契约变更（如换 `keyAlgorithm`）必须抬
  `clientVersion` 并同步服务端最低版本策略（P2.7 强制更新链路）。
- **包体积/更新**：内嵌产物意味着 Client 每次发版都要重打 APK；沿用 P2.7 的 R2 固定文件名别名
  （`BakaGame-<version>-release.apk` 实际名 + 无版本别名）分发。

## 8. 与计划文档的偏差与已知限制

- **未编译验证**：交付环境禁止联网安装依赖，Gradle/AGP/Capacitor 均未实际跑过；首次构建按 §6 排错
  （重点核对本地 `BridgeActivity.init()`/`bridge.registerPlugin` 与所用 Capacitor 大版本签名一致，
  如 CLI 更新模板可 `cap add android` 重新生成后把 `channel/` 源码平移过去）。
- 密钥算法选了 **EC P-256 + SHA256withECDSA**（AndroidKeyStore 的 Ed25519 需 API 33+，
  attestation 机型覆盖不齐）；协议 `keyAlgorithm` 字段为将来分叉留了位。
- 原生插件直接内嵌 app 模块并由 `MainActivity` 注册，不做独立 npm 插件包：桥接 JS 通过
  `window.Capacitor.registerPlugin('BakaChannel')` 取运行时代理。
- 本机未设 `ANDROID_HOME`（SDK 实际在 `D:\AndroidSdk`），`buildToolsVersion` 已钉在已装的 36.0.0，
  避免 AGP 触发联网下载 35.0.0。
- `Mobile/` 不在 `pnpm-workspace.yaml` 成员内且本期不得改动根配置，故用 npm 独立安装；
  将来若要并入 workspace，改 `packages:` 列表即可，本目录无需变动。

### 通道证明闭环：本轮真实状态（必须如实读）

§3 的闭环代码已经写完，但**一行都没跑过**：本机没有 Android SDK 构建（`gradle` / AGP 不可用），
`BakaChannelPlugin.kt` 与 `KeystoreChannel.kt` 均未编译，`baka-bridge.js` 也没在真实 WebView 里跑过一次。
以下每一条都要在真机上验证，不要当成已可用：

| 待验证 | 具体风险 |
|---|---|
| **移动端 id 词表** | 服务端 `ClientChannel.ts` 的 `HARD_FAIL_IDS` / `SOFT_FAIL_IDS` 目前**只有桌面那套 id**。本壳上报 `root_su:/system/xbin/su` 这类词表外的 id 时，服务端按「未知即不信任」处理，结果是 `CLIENT_UNTRUSTED`。而 `judgeSelfCheck` 在 **`register` 与 `attest` 两处都会跑**，所以闭环第一步（注册）就会被拒——**移动端整条链路目前拿不到票**。需要服务端补一份移动端词表（追加，不得改名）。 |
| 带冒号的动态 id | 上面这类 id 形如 `root_magisk:<path>`，长度可能超过服务端 `maxLength: 64`。桥接层的 `clampIds` 只会截断（`root_su:/sys…`），截断后与服务端词表对不上，**同样是被拒**。词表落地时要为动态 id 设计定长前缀。 |
| `fetch` 的跨域与 Cookie | 壳内页面源是 `https://localhost`，请求打到 `https://game.baka.website`：属于跨域。`credentials: "include"` 能否带上登录会话 Cookie，取决于服务端 CORS 是否回 `Access-Control-Allow-Credentials` 且 Origin 白名单含该源、以及 Cookie 的 `SameSite`。当前未验证，失败表现为 `attest` 401/`LOGIN_REQUIRED`。 |
| DER 签名口径 | 服务端 ec 分支按 `DER SEQUENCE{r,s}` + SHA256 验签；`KeystoreChannel.sign` 的输出正是 `Signature("SHA256withECDSA")` 的原始 DER，`Base64.NO_WRAP`。**未经真实验签确认**，尤其要确认没有做二次哈希或 IEEE-P1363 转换。 |
| 票的一次性 | 桥接层「读一次即作废 + 4 秒轮询」在定时器被系统节流（App 后台）时靠 `visibilitychange` 补救；「同一张票被交两次」只有真实握手能暴露。 |
| `window.__BAKA_API_BASE__` | 覆盖入口只接受 https，但没有做域名白名单——若将来需要在测试机上打预览域，要求显式配置且发布包不给页面开放这个开关。 |

**页面侧还差一步**：`Client/src/lib/BakaChannel.ts` 的 `bakaChannelQuery()` 只拼 `clientType` + `clientVersion`，
**还没把 `channelTicket` 拼成 `ticket=`**（协议要求 `?clientType=…&clientVersion=…&ticket=…`，
服务端 `/api/cee/ws` 读 `ticket` 参数消费）。本壳已按契约把票备好，读取是同步的，前端一行就能带上——
不在本目录权限范围内，未改。同理 `Client/src/lib/CEEWs.ts` 在模块加载时就把查询串拼死，
重连会复用已被消费的票，需改成每次连接前重新取。
