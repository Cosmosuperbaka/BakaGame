import { describe, expect, test } from "bun:test";

import { canSeeRoundSecrets } from "../../src/domain/Visibility";

const player = { setsRound: false, spectator: false };
const spectator = { setsRound: false, spectator: true };
const setter = { setsRound: true, spectator: false };

describe("回合秘密的可见性", () => {
  test("局中普通参与者看不到，无论旁观开关如何", () => {
    expect(canSeeRoundSecrets(player, true, false)).toBe(false);
    expect(canSeeRoundSecrets(player, true, true)).toBe(false);
  });

  test("局中旁观者只在房间开启旁观可见答案时可见", () => {
    expect(canSeeRoundSecrets(spectator, true, false)).toBe(false);
    expect(canSeeRoundSecrets(spectator, true, true)).toBe(true);
  });

  test("出题一方局中始终可见", () => {
    expect(canSeeRoundSecrets(setter, true, false)).toBe(true);
    expect(canSeeRoundSecrets({ setsRound: true, spectator: true }, true, false)).toBe(true);
  });

  test("回合结束后全员可见", () => {
    expect(canSeeRoundSecrets(player, false, false)).toBe(true);
    expect(canSeeRoundSecrets(spectator, false, false)).toBe(true);
  });
});
