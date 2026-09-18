import { createDefaultCCBSettings, type CCBSettings } from "@bakagame/shared";

export function ccbPresets(year = new Date().getFullYear()): Record<string, CCBSettings> {
  const base = { ...createDefaultCCBSettings(year), startYear: year - 10, topNSubjects: 50, subjectTagNum: 3 };
  const make = (settings: Partial<CCBSettings>): CCBSettings => ({ ...structuredClone(base), ...settings });
  return {
    "多人默认": createDefaultCCBSettings(year),
    "入门": make({ startYear: year - 5, topNSubjects: 30, characterNum: 3, useHints: [5, 3] }),
    "冻鳗高手": make({ startYear: year - 20, topNSubjects: 5, useSubjectPerYear: true, mainCharacterOnly: false, subjectSearch: false }),
    "老番享受者": make({ startYear: 2000, endYear: 2015, topNSubjects: 5, useSubjectPerYear: true, subjectSearch: false }),
    "瓶子严选": make({ startYear: 2005, topNSubjects: 75, characterNum: 10, maxAttempts: 7, characterTagNum: 5 }),
    "木柜子痴": make({ useIndex: true, indexId: 75522, subjectSearch: false }),
    "二游高手": make({ useIndex: true, indexId: 77344, mainCharacterOnly: false, characterNum: 30 }),
    "米哈游高手": make({ useIndex: true, indexId: 77186, mainCharacterOnly: false, characterNum: 40, subjectSearch: false }),
    "MOBA糕手": make({ useIndex: true, indexId: 76637, mainCharacterOnly: false, characterNum: 100, subjectSearch: false }),
  };
}
