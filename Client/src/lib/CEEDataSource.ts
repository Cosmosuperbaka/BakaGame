import { createContext, useContext } from "react";
import type { CEECharacterSummary, CEEImageSize, CEESubjectSummary } from "@bakagame/shared";
import { useCEEStore } from "@/stores/UseCEEStore";
import { useCEERankedStore } from "@/stores/UseCEERankedStore";

/**
 * 搜索与取图在「多人房」和「排位」下的两种来源。组件只认这个接口：
 * 命令发到哪、要不要房间凭据，都由外层挂的 Provider 决定。
 *
 * 成员写成函数属性而不是方法：调用点会把它们从对象上摘下来当回调传，
 * 方法签名带的隐式 `this` 会让 `unbound-method` 判成丢上下文的用法。
 */
export interface CEEDataSource {
  searchCharacters: (keyword: string) => Promise<CEECharacterSummary[]>;
  searchSubjects: (keyword: string) => Promise<CEESubjectSummary[]>;
  loadSubjectCharacters: (subjectId: number) => Promise<CEECharacterSummary[]>;
  characterImage: (characterId: number, size: CEEImageSize) => Promise<string | undefined>;
  /** 排位没有作品封面命令时返回 undefined，组件显示类型图标。 */
  subjectImage: (subjectId: number) => Promise<string | undefined>;
  /** MCP 接管时搜索框只回显；排位恒为 false。 */
  useControlled: () => boolean;
  /**
   * `LazyImage` 缓存键的前缀：解析结果与失败都按 `cacheKey` 全局记账，
   * 同一角色在两种来源下不能互相污染。多人房沿用既有键名，页面行为零变化。
   */
  cacheKeyPrefix: string;
}

const roomSearchCharacters = (keyword: string) => useCEEStore.getState().searchCharacters(keyword);
const roomSearchSubjects = (keyword: string) => useCEEStore.getState().searchSubjects(keyword);
const roomLoadSubjectCharacters = (subjectId: number) =>
  useCEEStore.getState().loadSubjectCharacters(subjectId);
const roomCharacterImage = async (characterId: number, size: CEEImageSize) => {
  const { imageUrl } = await useCEEStore
    .getState()
    .sendCommand("cee.character.image", { characterId, size });
  return imageUrl;
};
const roomSubjectImage = async (subjectId: number) => {
  const { imageUrl } = await useCEEStore.getState().sendCommand("cee.subject.image", { subjectId });
  return imageUrl;
};
const useRoomControlled = () => useCEEStore((state) => state.privateState?.mcpControlled === true);

/** 没有 Provider 时的缺省来源就是多人房那套：房间页面与既有测试零改动。 */
const roomCEEDataSource: CEEDataSource = {
  searchCharacters: roomSearchCharacters,
  searchSubjects: roomSearchSubjects,
  loadSubjectCharacters: roomLoadSubjectCharacters,
  characterImage: roomCharacterImage,
  subjectImage: roomSubjectImage,
  useControlled: useRoomControlled,
  cacheKeyPrefix: "cee",
};

/** 排位页用 `<CEEDataSourceContext.Provider value={rankedCEEDataSource}>` 包住搜索与图片组件。 */
export const CEEDataSourceContext = createContext<CEEDataSource>(roomCEEDataSource);

export function useCEEDataSource(): CEEDataSource {
  return useContext(CEEDataSourceContext);
}

/** 排位页用的数据源：命令一律走 `useCEERankedStore`，不碰房间。 */
export const rankedCEEDataSource: CEEDataSource = {
  searchCharacters: (keyword) => useCEERankedStore.getState().searchCharacters(keyword),
  searchSubjects: (keyword) => useCEERankedStore.getState().searchSubjects(keyword),
  loadSubjectCharacters: (subjectId) =>
    useCEERankedStore.getState().loadSubjectCharacters(subjectId),
  characterImage: (characterId, size) =>
    useCEERankedStore.getState().characterImage(characterId, size),
  // 服务端没有排位的作品封面命令：直接给 undefined，作品行显示类型图标而不是空跑一次请求。
  subjectImage: async () => undefined,
  useControlled: () => false,
  cacheKeyPrefix: "cee-ranked",
};
