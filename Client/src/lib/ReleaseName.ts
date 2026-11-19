/**
 * 发布名口径的唯一出处：构建期上传 source map 时创建的 release 与运行时上报事件带的 release
 * 必须逐字相同，否则符号化与问题归并会静默失效。构建插件与运行时代码都从这里取。
 *
 * 提交号固定截 7 位，与服务端 `Release.ts` 的 release 口径一致：`git --short` 在前缀有歧义时会自动加长，
 * 两端就会给同一次构建报出两个不同的 release。
 */
export const RELEASE_COMMIT_LENGTH = 7;

export const shortCommit = (revision: string): string => revision.slice(0, RELEASE_COMMIT_LENGTH);

/** `V<版本>（<7 位提交>）`；版本取不到时按 0.0.0。 */
export const formatReleaseName = (version: string, commit: string): string =>
  `V${version || "0.0.0"}（${shortCommit(commit)}）`;
