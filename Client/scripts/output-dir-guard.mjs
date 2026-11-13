import { existsSync } from "node:fs";
import path from "node:path";

/** 脚本在自己产出的目录里放的标记文件：有它才证明这个目录是脚本以前创建的。 */
export const OUTPUT_MARKER = ".generated-by-script";
/** 约定的目录名前缀：名字本身就说明这是截图产物，而不是源码目录。 */
export const OUTPUT_PREFIX = "storybook-shots";

/**
 * 截图脚本会在开始前递归删除输出目录。`--out` 来自命令行，误写成 `.`、`..` 或源码目录
 * 就会把工作区删光，所以删除之前先校验：
 * 1. 必须是 root 的真子目录（不能是 root 本身、祖先、也不能越出 root）；
 * 2. 目录不存在时无物可删，放行；
 * 3. 已存在时，目录名以约定前缀开头，或里面有脚本自己放的标记文件，否则拒绝。
 * 返回规范化后的绝对路径。
 */
export function assertSafeOutputDir(root, target) {
  const resolvedRoot = path.resolve(root);
  const resolved = path.resolve(resolvedRoot, target);
  const relative = path.relative(resolvedRoot, resolved);
  if (relative === "" || relative.startsWith("..") || path.isAbsolute(relative))
    throw new Error(`输出目录必须是 ${resolvedRoot} 内部的子目录，拒绝：${resolved}`);
  if (!existsSync(resolved)) return resolved;
  const named = path.basename(resolved).startsWith(OUTPUT_PREFIX);
  if (!named && !existsSync(path.join(resolved, OUTPUT_MARKER)))
    throw new Error(
      `拒绝清空 ${resolved}：目录已存在，名字不以 ${OUTPUT_PREFIX} 开头，里面也没有本脚本留下的标记文件`
    );
  return resolved;
}
