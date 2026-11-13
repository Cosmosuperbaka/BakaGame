import { describe, expect, it } from "vitest";
import { roomPhaseLabel } from "./AdminPhases";

// 枚举本身由 AdminPhases 里的 Record 在编译期钉住；这里列出当前取值，守「每个都有中文名」。
const FAKER_PHASES = [
  "waiting",
  "assigningQuestioner",
  "wordSubmission",
  "description",
  "voting",
  "tieBreak",
  "night",
  "blankGuess",
  "feedback",
  "gameOver",
];
const SONG_PHASES = ["waiting", "choosingSubmitter", "submittingSong", "playing", "roundResult"];

describe("房间阶段中文名", () => {
  it("三款玩法的每个阶段都有中文名，不露出英文枚举", () => {
    for (const phase of FAKER_PHASES) expect(roomPhaseLabel("faker", phase)).toMatch(/[一-龥]/);
    for (const phase of SONG_PHASES) expect(roomPhaseLabel("song", phase)).toMatch(/[一-龥]/);
    for (const phase of [
      "waiting",
      "choosingSetter",
      "preparing",
      "answering",
      "guessing",
      "settled",
    ])
      expect(roomPhaseLabel("cee", phase)).toMatch(/[一-龥]/);
  });

  it("同一个英文词在不同玩法里按各自的口径", () => {
    expect(roomPhaseLabel("faker", "waiting")).toBe("等待中");
    expect(roomPhaseLabel("song", "playing")).toBe("听歌作答");
  });

  it("服务端新增了尚未登记的阶段时原样显示，不空白", () => {
    expect(roomPhaseLabel("song", "brandNewPhase")).toBe("brandNewPhase");
  });
});
