import { expect, test } from "bun:test";

import {
  assignRoles,
  computeVoteOutcome,
  createDefaultRoleConfig,
  ensureRoomId,
  evaluateBlankGuess,
  getRoomRoleLimits,
  normalizeWordPair,
  shouldEnterFinalBlankGuess,
  validateRoleConfig,
} from "../src/domain/rules";
import { isValidRoomId, type GameRound } from "../src/domain/model";

test("房间号校验：四位数字与测试房间号合法，其余一律拒绝", () => {
  for (const valid of ["0000", "1234", "9999", "Oblivionis", "oblivionis", " 1234 "]) {
    expect(isValidRoomId(valid)).toBe(true);
    expect(() => ensureRoomId(valid)).not.toThrow();
  }

  for (const invalid of ["", "12", "12345", "abcd", "12a4", "room", "１２３４"]) {
    expect(isValidRoomId(invalid)).toBe(false);
    expect(() => ensureRoomId(invalid)).toThrow();
  }

  // 测试房间号统一归一成标准大小写，避免同房间分裂成两间。
  expect(ensureRoomId("oblivionis")).toBe("Oblivionis");
});

// ==================== 纯规则测试 ====================

test("弃权票会单独统计且不会成为最高票玩家", () => {
  const outcome = computeVoteOutcome([
    { voterId: "voter-1", targetId: "abstain" },
    { voterId: "voter-2", targetId: "player-1" },
  ]);

  expect(outcome.maxVotes).toBe(1);
  expect(outcome.abstainCount).toBe(1);
  expect(outcome.leaders).toEqual(["player-1"]);
  expect(outcome.counts).toEqual({ abstain: 1, "player-1": 1 });
});

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
    ),
  ).toThrow();
});

test("天使与白板在任意房间人数下都只会各分配一人", () => {
  const playerIds = Array.from({ length: 20 }, (_, index) => `p${index + 1}`);
  const limits = getRoomRoleLimits(playerIds.length);
  const result = assignRoles(
    playerIds,
    {
      undercoverCount: 5,
      hasAngel: true,
      hasBlank: true,
    },
    ["苹果", "香蕉"],
    "水果",
    {
      nextInt: (maxExclusive: number) => maxExclusive - 1,
    },
  );
  const roles = Object.values(result.assignments).map((assignment) => assignment.role);

  expect(limits).toEqual({
    maxUndercoverCount: 5,
    canEnableAngel: true,
    canEnableBlank: true,
  });
  expect(roles.filter((role) => role === "angel")).toHaveLength(1);
  expect(roles.filter((role) => role === "blank")).toHaveLength(1);
});

test("手动身份不能绕过单天使单白板约束", () => {
  const playerIds = Array.from({ length: 12 }, (_, index) => `p${index + 1}`);
  const manualRoles = Object.fromEntries(
    playerIds.map((playerId) => [playerId, "civilian"]),
  ) as Record<string, "civilian" | "undercover" | "angel" | "blank">;
  manualRoles.p1 = "undercover";
  manualRoles.p2 = "undercover";
  manualRoles.p3 = "undercover";
  manualRoles.p4 = "angel";
  manualRoles.p5 = "angel";
  manualRoles.p6 = "blank";

  expect(() =>
    assignRoles(
      playerIds,
      {
        undercoverCount: 3,
        hasAngel: true,
        hasBlank: true,
      },
      ["苹果", "香蕉"],
      "水果",
      { nextInt: (maxExclusive: number) => maxExclusive - 1 },
      manualRoles,
    ),
  ).toThrow();
});

test("天使从 8 人开启且卧底上限按四分之一向上取整", () => {
  expect(getRoomRoleLimits(7)).toEqual({
    maxUndercoverCount: 2,
    canEnableAngel: false,
    canEnableBlank: false,
  });
  expect(getRoomRoleLimits(8)).toEqual({
    maxUndercoverCount: 2,
    canEnableAngel: true,
    canEnableBlank: true,
  });
  expect(getRoomRoleLimits(9).maxUndercoverCount).toBe(3);
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
    descriptionOrder: [],
    descriptions: [],
    descriptionSubmittedBy: [],
    votes: [],
    voteHistory: [],
    nightActions: [],
    blankGuessUsed: false,
    blankGuessRecords: [],
    tieBreakCount: 0,
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
    descriptionOrder: [],
    descriptions: [],
    descriptionSubmittedBy: [],
    votes: [],
    voteHistory: [],
    nightActions: [],
    blankGuessUsed: false,
    blankGuessRecords: [],
    tieBreakCount: 0,
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
