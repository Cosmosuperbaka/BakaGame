import type { BangumiDataProvider } from "../../src/infrastructure/BangumiDataProvider";

/** 没被覆盖的方法：被调用说明用例的桩不完整，直接报出来而不是悄悄返回空值。 */
const notStubbed = (method: keyof BangumiDataProvider) => async (): Promise<never> => {
  throw new Error(`fakeBangumiProvider: ${method} 未提供假实现`);
};

/**
 * 类型完整的 Bangumi 假实现：用例只覆盖搜索与详情，其余方法给出显式失败桩，
 * 不必再整体 `as unknown as` 绕过类型检查。
 */
export const fakeBangumiProvider = (
  overrides: Partial<BangumiDataProvider> = {}
): BangumiDataProvider => ({
  searchSubjects: notStubbed("searchSubjects"),
  getSubject: notStubbed("getSubject"),
  chooseRandomSubject: notStubbed("chooseRandomSubject"),
  resolveCharacterImage: notStubbed("resolveCharacterImage"),
  resolveSubjectImage: notStubbed("resolveSubjectImage"),
  ...overrides,
});
