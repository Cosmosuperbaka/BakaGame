/**
 * 从主题样式表原文里取令牌，供构建插件与离线脚本读颜色（站点图标底色、分享卡片）。
 * 只做纯文本解析、不 import 任何模块：Vite 配置与 Node 脚本都能直接引用。
 * 选择器写法与 `Registry.test.ts` 核对的一致：亮色块的选择器列表里有 `[data-theme="<id>"]`。
 */

/** 亮色块的声明原文（不含花括号）；注释先抹掉，找不到时返回 `undefined`。 */
export function themeLightBlock(css: string, id: string): string | undefined {
  const selector = `[data-theme="${id}"]`;
  const source = css.replace(/\/\*[\s\S]*?\*\//g, "");
  for (const match of source.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    if (match[1].split(",").some((part) => part.trim() === selector)) return match[2];
  }
  return undefined;
}

/** 亮色块里某个自定义属性的原值（去掉首尾空白）；`name` 带前导 `--`。 */
export function themeLightToken(css: string, id: string, name: string): string | undefined {
  const block = themeLightBlock(css, id);
  if (!block) return undefined;
  for (const declaration of block.split(";")) {
    const pair = declaration.match(/^\s*(--[\w-]+)\s*:([\s\S]*)$/);
    if (pair && pair[1] === name) return pair[2].replace(/\s+/g, " ").trim();
  }
  return undefined;
}
