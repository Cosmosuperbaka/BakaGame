# BakaGame 移动端 Android 壳（Capacitor）

CEE 反作弊计划 P3 的客户端部分：Capacitor 壳 + **内嵌** `Client/` 构建产物 + `BakaChannel` 原生插件。
与桌面端（远程 URL）不同，移动端必须打包产物（商店审核 + 离线可用）。UI 全部复用 `Client/`，
前端桥接只有 `bridge/baka-bridge.js` 一处，桥接本身不需要改 `Client/` 源码；通行密钥等能力走
Client 自己的 WebAuthn 代码（见 §7.5）。本期不做 iOS；协议 `clientType: "mobile"` 不区分平台。

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

流程与判定约束见 [`Server/docs/ClientChannel.md`](../Server/docs/ClientChannel.md) §2/§3，字段与词表以代码为准。
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
默认地址写死在桥接脚本的常量里（读 `Mobile/bridge/baka-bridge.js`），可由页面 `window.__BAKA_API_BASE__` 覆盖，**只接受 https**
（与桌面壳 `config.rs` 同口径：不给「把签名发到假站」留口子）。

## 4. selfCheck 事实码

判定规则沿用桌面端口径：`hardFail` 任一 → 拒进 `BakaAntiCheat` 房（`CLIENT_UNTRUSTED`）；
`softFail ≥ 2` → 拒；`= 1` 放行并标记 `integrity: 'suspect'`。**服务端是最终判定方**，
`attestationLevel` 是客户端解析扩展的展示值，仅供参考（服务端验过链之后用自己的结论覆盖它）。

服务端按**冒号前的前缀**匹配 `Server/src/infrastructure/ClientChannel.ts` 的 `SELF_CHECK_WEIGHTS`，
后缀（包名、su 路径）只进日志；未登记的前缀失败关闭 = 拒。所以下表**新增一项必须同步服务端**，
否则正常设备直接进不了房。词表与归类以 `SELF_CHECK_WEIGHTS` 为准，判定原则见 `Server/docs/ClientChannel.md` §3。

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
├── scripts/apk.mjs         # Gradle 定位（wrapper 声明 → 同版本缓存 → PATH）并跑构建
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
Gradle 的版本出处是 `android/gradle/wrapper/gradle-wrapper.properties`（必须与 CI 的 Setup Gradle
同一枚、且落在 `android/build.gradle` 里 AGP 的支持范围内，由 `Server/scripts/BuildToolchain.mjs` 断言）；
`apk.mjs` 只取缓存里与声明同枚的发行版，取不到就报错，不会退回版本号最大的那一枚。

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

### 7.1 一次性：建密钥库并接上 Gradle

```powershell
# JDK 17 的 keytool（AGP 要求 17，用它自带的即可）；文件绝不入库（Mobile/.gitignore 已挡）
keytool -genkeypair -v -storetype PKCS12 `
  -keystore Mobile\keystore\bakagame-release.keystore `
  -alias bakagame -keyalg RSA -keysize 2048 -validity 10950
```

`Mobile/android/app/build.gradle` 已经按环境变量装配正式签名（**四项缺一律不装**，缺任意一项
release 就退回未签名产物，而不是让构建直接报错）：

| 环境变量 | 含义 |
|---|---|
| `BAKA_KEYSTORE_PATH` | 密钥库文件路径（CI 上指向解出来的那一份，见下） |
| `BAKA_KEYSTORE_PASSWORD` | 密钥库口令 |
| `BAKA_KEY_ALIAS` | 别名（本机建的库用 `bakagame`） |
| `BAKA_KEY_PASSWORD` | 私钥口令 |

```powershell
$env:BAKA_KEYSTORE_PATH = "Mobile\keystore\bakagame-release.keystore"
$env:BAKA_KEYSTORE_PASSWORD = "..."; $env:BAKA_KEY_ALIAS = "bakagame"; $env:BAKA_KEY_PASSWORD = "..."
npm run apk -- assembleRelease
```

产物 `android/app/build/outputs/apk/release/BakaGame-<version>-release.apk`（本地没有 SDK 时按 §6 排错）。
口令与密钥库本体都不进仓库，`Mobile/.gitignore` 已挡住 `keystore/`。

CI 上不落这些环境变量到机器，而是把密钥库整个 base64 化存进 secret：GitHub Actions 读
`BAKA_KEYSTORE_BASE64` 解到 `$RUNNER_TEMP/keystore/`，再把上表四项（口令三项来自
`BAKA_KEYSTORE_PASSWORD` / `BAKA_KEY_ALIAS` / `BAKA_KEY_PASSWORD`）传给
`gradle :app:assembleRelease`。没配 `BAKA_KEYSTORE_BASE64` 时那几步直接跳过，作业照常只出 debug 包并变绿。
生成命令：`certutil -encode` 或 `base64 -w0 Mobile/keystore/bakagame-release.keystore`。

### 7.2 取出签名摘要，配进服务端

服务端要的是 **base64(SHA-256(签名证书 DER))**，即 Key Attestation 里 `attestationApplicationId`
的 `signatureDigests`。三种取法结果应当一致，第一种最可信——它读的是真正装进机器的那个包。

```powershell
# A. 从 APK 读（build-tools 自带；`Signer #1 certificate SHA-256 digest:` 那行就是证书 DER 的 SHA-256）
D:\AndroidSdk\build-tools\36.0.0\apksigner.bat verify --print-certs `
  android\app\build\outputs\apk\release\BakaGame-<version>-release.apk
# 十六进制 → base64（本仓库一定有 node）
node -e "console.log(Buffer.from(process.argv[1],'hex').toString('base64'))" <64位十六进制>

# B. 从密钥库读（还没有 APK 时先算一遍，之后与 A 对照）
keytool -exportcert -keystore Mobile\keystore\bakagame-release.keystore -alias bakagame -file signer.der
openssl dgst -sha256 -binary signer.der | openssl base64

# C. 调试包：debug 密钥库在 %USERPROFILE%\.android\debug.keystore，别名 AndroidDebugKey，
#    上面两条命令换成它即可
```

取值对不对，有个自证：**结果一定是 44 个字符、以 `=` 结尾**（32 字节的标准 base64），且 B 法与
「node 换算 A 法十六进制」必须给出同一串。2026-10-19 用一次性密钥库在本机验过后半句
（同一枚 DER 的 openssl 输出与 node `createHash` 十六进制换算逐字相同）；A 法要等真有 APK 再跑，
`apksigner.bat` 的路径按本机 SDK 调整（此机 `build-tools` 装了 34.0.0 与 36.0.0）。

写进 `Server` 的 `.env` / CI secret（逗号分隔，可多枚）：

```
ANDROID_ATTESTATION_PACKAGE=website.baka.game
ANDROID_ATTESTATION_SIGNATURE_DIGESTS=<release 的 base64>,<debug 的 base64>
```

- 联调阶段把 debug 与 release 两枚都列上：只列 release 时，测试机上的 debug 包会被判
  `signature_digest_mismatch` → `CLIENT_UNTRUSTED`，链的其它结论一个都看不到。
- 摘要不配 → 只记 `signature_digest_unverified` 并封顶 `degraded`（认包名防不住重打包自签）。
  配了之后，注册返回 `degraded` 且**没有**这一条标记，就说明摘要命中了。
  口径与服务端判定见 [ClientChannel §3](../Server/docs/ClientChannel.md)。

### 7.3 换签名与商店的坑

- **Google Play 开了 Play App Signing 时，A 法读到的不是装机签名**：装机包由 Play 的签名密钥重签，
  得用 Play Console 里 App signing key certificate 的 SHA-256 指纹换算 base64。国内商店一般不改签名，
  但一律以「真机装上的那个包」用 A 法实测为准，不要按密钥库推。
- **签名轮换（rotation）**期间证明里同时列出新旧两枚证书，两枚都留在列表里；直接换密钥重装则只认新摘要，
  老包用户必须先卸载重装。
- **密钥库丢失 = 同名包无法覆盖安装**：`Mobile/keystore/` 不入库，但必须与口令一起异地备份。

### 7.4 其余分发口径

- **应用商店**：国内各安卓商店上架需软著/营业执照等资质与逐店审核，是商店分发路线上最高的固定成本。
  发布节奏：桥接契约变更（如换 `keyAlgorithm`）必须抬 `clientVersion` 并同步服务端最低版本策略（服务端强制更新链路）。
- **包体积/更新**：内嵌产物意味着 Client 每次发版都要重打 APK；沿用发布流水线的固定文件名别名
  （`BakaGame-<version>-release.apk` 实际名 + 无版本别名）分发。

### 7.5 WebView 内的通行密钥（WebAuthn）

壳内的通行密钥入口能否真正调起系统验证器，取决于三层前提，缺任何一层都会表现为「入口在，但点了没反应或报无可用验证器」：

1. **WebView 支持且已由宿主开启**：系统 WebView 124+ 才实现 WebAuthn；壳用 `androidx.webkit` 的
   `setWebAuthenticationSupport(..., WEB_AUTHENTICATION_SUPPORT_FOR_APP)` 显式开启（见 `MainActivity.kt`）。
   `WebViewFeature.isFeatureSupported` 兜住旧 WebView，页面按不支持 WebAuthn 隐藏整段入口。
2. **页面 origin 与 rpID 同域**：`rpID` 取前端页面域名（见 [Server/docs/Account.md](../Server/docs/Account.md) §1），
   Ceremony 发生在页面源里。壳的默认 origin 是 `https://localhost`，与站点域名不同域，会以 `SecurityError` 失败。
   `capacitor.config.ts` 用构建期的 `VITE_SERVER_URL`（或显式 `BAKA_PASSKEY_HOST`）把 `server.hostname`
   设成站点 host；`cap sync` 时这个变量必须还在环境里。只接受 https、默认端口、无路径的站点地址，
   IP、IPv6、带端口或路径的值会被忽略。未注入时保持 `https://localhost`，普通功能不受影响。
3. **Digital Asset Links**：`https://<rpID>/.well-known/assetlinks.json` 必须声明包名
   `website.baka.game` 与**实际装机包**的 SHA-256 签名摘要。文件维护在
   `Client/public/.well-known/assetlinks.json`，随 Web 构建一起发布；换签名或轮换后必须同步更新，
   否则 `FOR_APP` 关联失败。摘要与指纹是敏感信息，维护时不要贴进聊天、文档或提交信息。

`server.hostname` 生效后，本地资源服务会接管该域名下的所有路径，包括 `/api/*`；Capacitor 会把
无扩展名的路径回成 `index.html`。因此 `MainActivity.kt` 安装了 `ApiPassthroughWebViewClient`：
`/api/*` 返回 `null` 交给真实网络，其余路径仍由本地资源服务提供（SPA 深链刷新不 404）。

真机验证注意：CI 的 debug 包用的是 runner 上临时生成的 debug keystore，其指纹无法预先写进
assetlinks，不能用它验收通行密钥；请用正式签名包，或本机固定 debug keystore 构建并把指纹列进
assetlinks 后再测。

## 8. 已知限制与待真机验证

- **通行密钥仍待真机验证**：需要 WebView 124+、origin 与 rpID 同域、assetlinks 命中的正式签名包；
  本仓库的 CI 只负责编译 APK，不覆盖系统验证器与 DAL 关联。WebView 低于 124 时页面会按不支持降级
  （入口隐藏），这是预期行为，不代表注册链路已通过。
- **编译已通，运行未验**：本机工具链已能构建 debug APK；真机启动、签名发布包与 CI 产物仍按下文逐项确认。
  首次构建按 §6 排错（重点核对本地 `BridgeActivity.init()`/`bridge.registerPlugin` 与所用 Capacitor
  大版本签名一致，如 CLI 更新模板可 `cap add android` 重新生成后把 `channel/` 源码平移过去）。
- 密钥算法选了 **EC P-256 + SHA256withECDSA**（AndroidKeyStore 的 Ed25519 需要更高的系统 API，
  且 attestation 机型覆盖不齐）；协议 `keyAlgorithm` 字段为将来分叉留了位。
- 原生插件直接内嵌 app 模块并由 `MainActivity` 注册，不做独立 npm 插件包：桥接 JS 通过
  `window.Capacitor.registerPlugin('BakaChannel')` 取运行时代理。
- SDK 与 `buildToolsVersion` 钉在构建清单里：改版本前先确认构建机离线拿得到对应组件，
  别让 AGP 在发布流程里触发联网下载。
- `Mobile/` 不在 `pnpm-workspace.yaml` 成员内且本期不得改动根配置，故用 npm 独立安装；
  将来若要并入 workspace，改 `packages:` 列表即可，本目录无需变动。

### 通道证明闭环：仍要在真机上确认

§3 的闭环代码已经写完，并已通过 APK 编译；但**端到端链路仍要在真机上确认**：
`BakaChannelPlugin.kt` 与 `KeystoreChannel.kt` 的签名、注册与票据闭环，以及 `baka-bridge.js`
在真实 WebView 里的运行，都还没有用真实设备走通过。前端一侧已接入：握手查询串每次建连时重新生成并带上
`ticket`（读法见 `Client/src/lib/BakaChannel.ts` 与 `Client/src/lib/CEEWs.ts`）。
以下每一条都要在真机上验证，不要当成已可用：

| 待验证 | 具体风险 |
|---|---|
| **移动端 id 词表** | 本壳上报的每个自检 id 都必须在服务端词表里有归类，未识别即不信任，注册第一步就会被拒、整条链路拿不到票。判定在 `register` 与 `attest` 两处都会跑；词表**只能追加、不得改名**（改名等于换协议，两端要同批抬最低版本）。 |
| 带冒号的动态 id | 形如 `root_magisk:<path>` 的动态 id 受服务端长度上限约束，桥接层只会截断，截断后与服务端词表对不上，**同样是被拒**。词表落地时要为动态 id 设计定长前缀。 |
| `fetch` 的跨域与 Cookie | 壳内页面源与站点域不同源。`credentials: "include"` 能否带上登录会话 Cookie，取决于服务端 CORS 是否回 `Access-Control-Allow-Credentials` 且 Origin 白名单含该源、以及 Cookie 的 `SameSite`。失败表现为 `attest` 401/`LOGIN_REQUIRED`。 |
| DER 签名口径 | 服务端 ec 分支按 `DER SEQUENCE{r,s}` + SHA256 验签；`KeystoreChannel.sign` 的输出正是 `Signature("SHA256withECDSA")` 的原始 DER，`Base64.NO_WRAP`。**未经真实验签确认**，尤其要确认没有做二次哈希或 IEEE-P1363 转换。 |
| 票的一次性 | 桥接层「读一次即作废 + 4 秒轮询」在定时器被系统节流（App 后台）时靠 `visibilitychange` 补救；「同一张票被交两次」只有真实握手能暴露。 |
| `window.__BAKA_API_BASE__` | 覆盖入口只接受 https，但没有做域名白名单——若将来需要在测试机上打预览域，要求显式配置且发布包不给页面开放这个开关。 |
