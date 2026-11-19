import type { CEEPayload, CEEResponse } from "../shared/CEE";
import type { CEEDataProvider } from "../infrastructure/CEEData";

/**
 * 数据类命令的唯一实现：增强房、原版房与排位三处共用。
 * 这里只负责「按命令取数据并包成响应」；谁能发、什么阶段能发、限额与检索台账都是调用方的事，
 * 必须在调用本函数之前声明，三处的准入口径本来就不同，不在这里统一。
 * 排位命令的载荷与同名的非排位命令一致，排位入口按对应的类型传入即可。
 */
export type CEEDataCommand =
  | "cee.character.search"
  | "cee.subject.search"
  | "cee.subject.characters"
  | "cee.subject.lookup"
  | "cee.directory.import"
  | "cee.character.image"
  | "cee.subject.image";

type DataCommandTable = {
  readonly [K in CEEDataCommand]: (
    data: CEEDataProvider,
    payload: CEEPayload<K>
  ) => Promise<CEEResponse<K>>;
};

const DATA_COMMANDS: DataCommandTable = {
  "cee.character.search": async (data, payload) => ({
    results: await data.searchCharacters(payload.keyword),
  }),
  "cee.subject.search": async (data, payload) => ({
    results: await data.searchSubjects(payload.keyword),
  }),
  "cee.subject.characters": async (data, payload) => ({
    results: await data.getSubjectCharacters(payload.subjectId),
  }),
  "cee.subject.lookup": async (data, payload) => ({
    results: await data.getSubjects(payload.subjectIds),
  }),
  "cee.directory.import": (data, payload) => data.importDirectory(payload.indexId),
  // 列表是方形缩略图，尺寸缺省即方格图；大图用途走服务端内部调用，不带这条命令。
  "cee.character.image": async (data, payload) => ({
    imageUrl: await data.resolveCharacterImage(payload.characterId, payload.size ?? "grid"),
  }),
  "cee.subject.image": async (data, payload) => ({
    imageUrl: await data.resolveSubjectImage(payload.subjectId),
  }),
};

export const runCEEDataCommand = <K extends CEEDataCommand>(
  data: CEEDataProvider,
  type: K,
  payload: CEEPayload<K>
): Promise<CEEResponse<K>> => DATA_COMMANDS[type](data, payload);
