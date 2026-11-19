/**
 * 主题注册表：界面「主题」的唯一清单。
 *
 * 主题与明暗是两个独立维度。主题决定整套语义令牌（颜色、表面、字体栈、圆角、阴影、纸纹理、字距与行高），
 * 写在同目录的 `<id>.css` 里；明暗由 `<html>` 上的 `.dark` 类切换，每款主题都自带亮、暗两套。
 * 业务组件只用语义令牌，不按主题分支写样式（见 DesignGuide「主题」）。
 *
 * 新增一款主题只动两处：同目录新增 `<id>.css`，这里加一项。其余消费方都从这里取：
 * - 设置里的主题选择按本表顺序列出；
 * - `index.html` 首帧脚本的合法值与默认值，由构建插件从本表写入（scripts/vite-plugins/ThemeRegistry.ts）；
 * - 主题样式表由 `ThemeStyles.ts` 按目录收集，Storybook 工具栏遍历本表；
 * - `Registry.test.ts` 核对样式表与本表一一对应，`DesignTokens.test.ts` 逐款核对令牌完整性与对比度。
 *
 * 本文件不 import 任何模块：Vite 配置与 Node 脚本（分享卡片）也直接读取它。
 */

export interface ThemeDefinition {
  /** 写进 `<html data-theme>` 与本地偏好的取值，同时是样式表文件名。只用小写字母与数字。 */
  readonly id: string;
  /** 设置里显示的名字。 */
  readonly label: string;
}

export const THEMES = [
  { id: "v0", label: "v0" },
  { id: "v1", label: "v1" },
  { id: "v2", label: "v2" },
] as const satisfies readonly ThemeDefinition[];

export type ThemeId = (typeof THEMES)[number]["id"];

/** 默认主题：没有偏好、偏好失效或脚本被禁用时都落到它，它的样式表同时兜底无 `data-theme` 的情形。 */
export const DEFAULT_THEME_ID: ThemeId = "v1";

export const THEME_IDS: readonly ThemeId[] = THEMES.map((theme) => theme.id);

export function isThemeId(value: unknown): value is ThemeId {
  return typeof value === "string" && (THEME_IDS as readonly string[]).includes(value);
}
