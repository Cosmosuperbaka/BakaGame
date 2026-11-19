import type { CEESettings } from "@bakagame/shared";

export const offOr = (value: number, text: string) => (value === 0 ? "关闭" : text);

/** 两个折叠组收起时的摘要。 */
export function summaries(settings: CEESettings) {
  return {
    // 这个面板只在房间确实开着反作弊时出现（建房那一刻决定，之后改不了），摘要无需再判开关。
    antiCheat: ["已开启：仅客户端、需登录"],
    question: [
      settings.answerMode === "manual" ? "指定出题人" : "随机出题",
      settings.useIndex
        ? `目录 ${settings.indexId ?? "未填"}`
        : `${settings.startYear}–${settings.endYear} 前 ${settings.topNSubjects} 部`,
      settings.mainCharacterOnly ? "仅主角" : `每部 ${settings.characterNum} 人`,
      settings.addedSubjects.length ? `追加 ${settings.addedSubjects.length} 部` : "",
    ],
    guess: [
      `${settings.maxAttempts} 次机会`,
      settings.timeLimit ? `每次 ${settings.timeLimit} 秒` : "不限行动时间",
      settings.syncMode ? "同步模式" : "",
      settings.nonstopMode ? "血战模式" : "",
      settings.globalPick ? "角色 BP" : "",
      settings.tagBan ? "标签 BP" : "",
    ],
  };
}
/** 草稿能否保存：年份倒挂、目录未填或目录还没同步入库时，自动保存先停住并给出原因。 */
export function settingsValidationMessage(
  draft: CEESettings,
  syncedIndexId: number | null
): string {
  if (draft.startYear > draft.endYear) return "起始年份不能晚于结束年份";
  if (draft.useIndex && !draft.indexId) return "请填写 Bangumi 目录编号";
  if (draft.useIndex && draft.indexId !== syncedIndexId) return "目录需要先同步，同步后自动保存";
  return "";
}
