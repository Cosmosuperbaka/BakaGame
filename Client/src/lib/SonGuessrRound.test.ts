import { describe, expect, it } from "vitest";

import { songDisplayRound } from "./SonGuessrRound";

describe("songDisplayRound", () => {
  it("选出题人与选歌阶段显示即将开始的下一轮", () => {
    expect(songDisplayRound("waiting", 0)).toBe(0);
    expect(songDisplayRound("choosingSubmitter", 0)).toBe(1);
    expect(songDisplayRound("submittingSong", 0)).toBe(1);
    expect(songDisplayRound("playing", 1)).toBe(1);
    expect(songDisplayRound("roundResult", 1)).toBe(1);
    expect(songDisplayRound("choosingSubmitter", 1)).toBe(2);
    expect(songDisplayRound("submittingSong", 1)).toBe(2);
    expect(songDisplayRound("waiting", 3)).toBe(3);
  });
});
