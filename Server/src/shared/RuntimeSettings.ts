import { z } from "zod";

/**
 * 运行期旋钮（T3）：线上生效值存 `app_setting`，环境变量同名项只是**缺省**。
 *
 * 入选判据只有一条：改它的时候正好在停机窗口外，且改了只影响后续行为。
 * 凭据、数据库地址、监听与来源名单永远不在此列（分层见 `Agents/Conventions.md` §5
 * 与 `Server/src/config/env/Registry.ts`）。
 */
export const runtimeSettingKeySchema = z.enum([
  "clientMinDesktopVersion",
  "clientMinMobileVersion",
  "enableGeneralUnblock",
]);

export type RuntimeSettingKey = z.infer<typeof runtimeSettingKeySchema>;

/** 版本门槛：空串 = 不设门槛（与 `CLIENT_MIN_*_VERSION` 的口径一致）。 */
const versionOrEmpty = z
  .string()
  .trim()
  .refine(
    (value) => value === "" || /^\d+\.\d+\.\d+$/.test(value),
    "版本要形如 0.1.2，空串表示不设门槛"
  );

const booleanText = z
  .string()
  .trim()
  .refine((value) => value === "true" || value === "false", "只能是 true 或 false");

export interface RuntimeSettingDescriptor {
  key: RuntimeSettingKey;
  /** 缺省值来自哪个环境变量；后台把它显示成「未覆盖时的取值」。 */
  envVar: string;
  title: string;
  /** 给管理员看的一句话后果，不写操作步骤。 */
  note: string;
  /** 校验存进来的原始字符串；不合格的值不落库。 */
  schema: z.ZodString;
  /** 环境变量侧的缺省值（规范化成同一个字符串形状）。 */
  defaultValue: (defaults: RuntimeSettingDefaults) => string;
  /** 生效值怎么解释：布尔项按 `true` 判定，版本项原样比较。 */
  kind: "version" | "boolean";
}

/** 只声明用到的几项，避免 shared 反向依赖服务端配置模块。 */
export interface RuntimeSettingDefaults {
  clientMinDesktopVersion?: string;
  clientMinMobileVersion?: string;
  enableGeneralUnblock?: boolean;
}

export const RUNTIME_SETTINGS: Record<RuntimeSettingKey, RuntimeSettingDescriptor> = {
  clientMinDesktopVersion: {
    key: "clientMinDesktopVersion",
    envVar: "CLIENT_MIN_DESKTOP_VERSION",
    title: "桌面壳最低准入版本",
    note: "低于该版本的桌面壳不能进反作弊房；通道证明协议破坏性变更时必须抬它。留空表示不设门槛。",
    schema: versionOrEmpty,
    defaultValue: (defaults) => defaults.clientMinDesktopVersion ?? "",
    kind: "version",
  },
  clientMinMobileVersion: {
    key: "clientMinMobileVersion",
    envVar: "CLIENT_MIN_MOBILE_VERSION",
    title: "移动壳最低准入版本",
    note: "同桌面项，作用于移动壳。发新版后在这里抬门槛，不需要重建容器。",
    schema: versionOrEmpty,
    defaultValue: (defaults) => defaults.clientMinMobileVersion ?? "",
    kind: "version",
  },
  enableGeneralUnblock: {
    key: "enableGeneralUnblock",
    envVar: "ENABLE_GENERAL_UNBLOCK",
    title: "网易云全局解灰",
    note: "关闭后受限曲目只回试听片段判定，不再尝试换取完整音频；改动只影响其后的请求。",
    schema: booleanText,
    defaultValue: (defaults) => (defaults.enableGeneralUnblock === false ? "false" : "true"),
    kind: "boolean",
  },
};

export const RUNTIME_SETTING_KEYS = runtimeSettingKeySchema.options;

/** 后台列表项：缺省、库内覆盖值与当前生效值一起给出，避免管理员猜现在到底是多少。 */
export const adminRuntimeSettingSchema = z.object({
  key: runtimeSettingKeySchema,
  title: z.string(),
  note: z.string(),
  envVar: z.string(),
  /** 编辑器形态：后台据此决定用开关还是版本输入框，不再在前端硬写键名单。 */
  kind: z.enum(["version", "boolean"]),
  defaultValue: z.string(),
  /** 库内覆盖值；未设置时为 null。 */
  storedValue: z.string().nullable(),
  effectiveValue: z.string(),
  updatedAt: z.string().nullable(),
  /** 改动该键的管理员昵称；系统或未知来源为 null。 */
  updatedBy: z.string().nullable(),
});

export type AdminRuntimeSetting = z.infer<typeof adminRuntimeSettingSchema>;
