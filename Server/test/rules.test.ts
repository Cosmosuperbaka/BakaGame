import { expect, test } from "bun:test";

import {
  assignRoles,
  createDefaultRoleConfig,
  evaluateBlankGuess,
  normalizeWordPair,
  shouldEnterFinalBlankGuess,
  validateRoleConfig,
} from "../src/domain/rules";
import type { GameRound } from "../src/domain/model";

// ==================== 纯规则测试 ====================

test("词对会修剪空白并按无序去重规则归一化", () => {
  expect(normalizeWordPair([" 狗 ", "猫"])).toHaveLength(2);
  expect(() => normalizeWordPair(["猫", "猫"])).toThrow();
});

test("阵营配置会校验人数上限", () => {
  expect(() =>
    validateRoleConfig(
      {
        undercoverCount: 3,
        hasAngel: false,
        hasBlank: false,
      },
      4,
      false,
    ),
  ).toThrow();
});

test("角色分配在固定随机源下具有稳定顺序", () => {
  const result = assignRoles(
    ["p1", "p2", "p3", "p4"],
    createDefaultRoleConfig(),
    ["苹果", "香蕉"],
    undefined,
    {
      nextInt: (maxExclusive: number) => maxExclusive - 1,
    },
  );

  expect(result.assignments.p1.role).toBe("undercover");
  expect(result.assignments.p2.role).toBe("civilian");
});

test("残局条件满足时白板会进入猜词阶段", () => {
  const round: GameRound = {
    id: "round",
    phase: "night",
    day: 1,
    words: {
      pair: ["苹果", "香蕉"],
      civilianWord: "苹果",
      undercoverWord: "香蕉",
      blankHint: "水果",
    },
    assignments: {
      blank: { role: "blank", side: "blank", alive: true },
      under: { role: "undercover", side: "undercover", alive: true, word: "香蕉" },
      good: { role: "civilian", side: "good", alive: true, word: "苹果" },
    },
    descriptionCycle: 1,
    descriptions: [],
    descriptionSubmittedBy: [],
    votes: [],
    nightActions: [],
    blankGuessUsed: false,
    blankGuessRecords: [],
    pendingDisconnectPlayerIds: [],
  };

  const result = shouldEnterFinalBlankGuess(round);
  expect(result.shouldGuess).toBe(true);
  expect(result.blankPlayerId).toBe("blank");
});

test("白板猜词会按词对本身判断是否正确", () => {
  const round: GameRound = {
    id: "round",
    phase: "blankGuess",
    day: 1,
    words: {
      pair: ["苹果", "香蕉"],
      civilianWord: "苹果",
      undercoverWord: "香蕉",
      blankHint: "水果",
    },
    assignments: {
      blank: { role: "blank", side: "blank", alive: false },
    },
    descriptionCycle: 1,
    descriptions: [],
    descriptionSubmittedBy: [],
    votes: [],
    nightActions: [],
    blankGuessUsed: false,
    blankGuessRecords: [],
    blankGuessContext: {
      playerId: "blank",
      reason: "eliminated",
      resumePhase: "night",
    },
    pendingDisconnectPlayerIds: [],
  };

  expect(
    evaluateBlankGuess(round, ["香蕉", "苹果"], Date.now(), "eliminated").success,
  ).toBe(true);
});
