// ==================== CEE 设置默认值（纯值） ====================
// 浏览器首屏包不能携带 TypeBox：这里只放不依赖 schema 的值。按 schema 校验的设置文件解析
// `parseCEESettings` 留在 CEE.ts，客户端只在真正导入文件时动态加载，不复制一份手写校验。
import type { CEESettings } from "./CEE";

export const createDefaultCEESettings = (year = new Date().getFullYear()): CEESettings => ({
  startYear: year - 5,
  endYear: year,
  topNSubjects: 20,
  useSubjectPerYear: false,
  metaTags: ["", "", ""],
  useIndex: false,
  indexId: null,
  addedSubjects: [],
  mainCharacterOnly: true,
  characterNum: 6,
  maxAttempts: 10,
  timeLimit: 60,
  subjectSearch: true,
  subjectTagNum: 4,
  characterTagNum: 4,
  useHints: [],
  useImageHint: 0,
  globalPick: false,
  tagBan: false,
  syncMode: false,
  nonstopMode: false,
  answerMode: "random",
  bakaAntiCheat: false,
  allowAgents: false,
});

/** 房间是否按反作弊口径收口：只有显式 `true` 才算开启，缺省与 `false` 同义。 */
export const isCEEAntiCheatRoom = (settings: Pick<CEESettings, "bakaAntiCheat">): boolean =>
  settings.bakaAntiCheat === true;
