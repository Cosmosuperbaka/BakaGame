/**
 * 客户端安装包的固定别名地址：名字不带版本号、永远指向最新，旧链接长期有效。
 * 默认值即发布约定，只在换分发地址时才需要配环境变量。
 */
const DEFAULT_WINDOWS_PACKAGE_URL = "https://cdn.baka.website/files/BakaGame-latest-x64.exe";
const DEFAULT_ANDROID_PACKAGE_URL = "https://cdn.baka.website/files/BakaGame-latest-release.apk";

/**
 * 客户端通道与上游互通（T0/T2/T3 混合，逐条见 `env/Registry.ts`）：
 * 版本门槛与解灰开关属于运行期可改的运营旋钮（T3，见 `app_setting`），
 * 信任基准（包名与签名摘要）与上游密钥仍是引导项（T1）。
 * 分层口径见 `Agents/Conventions.md` §5。
 */
export interface EnvClientChannel {
  /**
   * 反作弊房接受的最低壳版本；空串 = 不设版本门槛。
   * 通道证明协议一旦破坏性变更必须抬这里，否则旧壳还能继续签名通关。
   */
  clientMinDesktopVersion?: string;
  clientMinMobileVersion?: string;
  /**
   * 客户端安装包的公开下载地址（CI 的 `client-publish` 作业推上去的固定别名）。
   * 首页下载弹窗与更新提醒都读这两条：服务端对地址发 HEAD 取回构建日期与文件大小，
   * 玩家点到的链接与这里同一处。空串 = 该平台不进列表。
   */
  clientPackageWindowsUrl?: string;
  clientPackageAndroidUrl?: string;
  /**
   * Android Key Attestation 的期望包名。不配 = 不校验证明链（带链注册只记 `degraded`）：
   * 包名是信任基准，写死默认值会让任何 APK 都能声称自己是我们的。
   */
  androidAttestationPackage?: string;
  /** 期望的 APK 签名证书摘要（base64，逗号分隔）。不配只能验包名，结论最高到 `degraded`。 */
  androidAttestationSignatureDigests?: string[];
  /** 原版兼容房地址；与密钥任一留空则不提供兼容入口。 */
  ceeOriginalServerUrl?: string;
  ceeOriginalAesSecret?: string;
  /** 网易云全局解灰：默认开启。 */
  enableGeneralUnblock?: boolean;
  /** QQ 音乐匿名补充检索：默认开启；关闭后没有 QQ 账号的房间只搜网易云。 */
  enableAnonymousQqSearch?: boolean;
}

export const readClientChannelEnv = (): EnvClientChannel => ({
  clientMinDesktopVersion: Bun.env.CLIENT_MIN_DESKTOP_VERSION?.trim() || undefined,
  clientMinMobileVersion: Bun.env.CLIENT_MIN_MOBILE_VERSION?.trim() || undefined,
  // 显式配成空串 = 这个平台不发（安卓没配签名密钥时就是这个状态），不给默认地址。
  clientPackageWindowsUrl:
    Bun.env.CLIENT_PACKAGE_WINDOWS_URL?.trim() ?? DEFAULT_WINDOWS_PACKAGE_URL,
  clientPackageAndroidUrl:
    Bun.env.CLIENT_PACKAGE_ANDROID_URL?.trim() ?? DEFAULT_ANDROID_PACKAGE_URL,
  // Android Key Attestation 的期望包名：不配就不校验证明链（带链注册只记 degraded）。
  // 写死包名等于替所有 APK 定一个信任基准，必须由部署方明确给出。
  androidAttestationPackage: Bun.env.ANDROID_ATTESTATION_PACKAGE?.trim() || undefined,
  androidAttestationSignatureDigests: (Bun.env.ANDROID_ATTESTATION_SIGNATURE_DIGESTS ?? "")
    .split(",")
    .map((item) => item.trim())
    .filter((item) => item.length > 0),
  ceeOriginalServerUrl: (Bun.env.CCB_ORIGINAL_SERVER_URL ?? "").trim().replace(/\/+$/, ""),
  ceeOriginalAesSecret: Bun.env.CCB_ORIGINAL_AES_SECRET,
  enableGeneralUnblock:
    Bun.env.ENABLE_GENERAL_UNBLOCK !== undefined ? Bun.env.ENABLE_GENERAL_UNBLOCK === "true" : true,
  enableAnonymousQqSearch:
    Bun.env.ENABLE_ANONYMOUS_QQ_SEARCH !== undefined
      ? Bun.env.ENABLE_ANONYMOUS_QQ_SEARCH === "true"
      : true,
});
