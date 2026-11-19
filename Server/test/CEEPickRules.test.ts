import { describe, expect, test } from "bun:test";
import {
  bannedCharacterIdsFor,
  isCharacterBanned,
  maskGuessTags,
  type CEEPickContext,
} from "../src/domain/CEEPickRules";
import type { CEEGuess } from "../src/shared/CEE";

const guess = (
  playerId: string,
  characterId: number,
  extra: { correct?: boolean; syncRound?: number } = {}
) => ({
  playerId,
  character: { id: characterId },
  correct: extra.correct ?? false,
  syncRound: extra.syncRound ?? 1,
});

const context = (overrides: Partial<CEEPickContext> = {}): CEEPickContext => ({
  playerId: "me",
  globalPick: true,
  syncMode: false,
  nonstopMode: false,
  syncRound: 1,
  ...overrides,
});

describe("全局 BP 规则", () => {
  test("只禁其他玩家猜过的角色；本人猜过的同角色不受限", () => {
    const guesses = [guess("other", 1), guess("other", 2), guess("me", 2)];
    expect(bannedCharacterIdsFor(guesses, context())).toEqual([1]);
    expect(isCharacterBanned(guesses, context(), 1)).toBe(true);
    expect(isCharacterBanned(guesses, context(), 2)).toBe(false);
    expect(isCharacterBanned(guesses, context(), 3)).toBe(false);
  });

  test("全局 BP 关闭时没有任何禁用", () => {
    const guesses = [guess("other", 1)];
    expect(bannedCharacterIdsFor(guesses, context({ globalPick: false }))).toEqual([]);
    expect(isCharacterBanned(guesses, context({ globalPick: false }), 1)).toBe(false);
  });

  test("同步模式只看往轮：本轮别人猜的不算", () => {
    const guesses = [guess("other", 1, { syncRound: 1 }), guess("other", 2, { syncRound: 2 })];
    expect(bannedCharacterIdsFor(guesses, context({ syncMode: true, syncRound: 2 }))).toEqual([1]);
    expect(bannedCharacterIdsFor(guesses, context({ syncMode: false, syncRound: 2 }))).toEqual([
      1, 2,
    ]);
  });

  test("答案在同步与血战下豁免，普通模式不豁免", () => {
    const guesses = [guess("other", 7, { correct: true, syncRound: 1 })];
    expect(bannedCharacterIdsFor(guesses, context())).toEqual([7]);
    expect(bannedCharacterIdsFor(guesses, context({ nonstopMode: true }))).toEqual([]);
    expect(bannedCharacterIdsFor(guesses, context({ syncMode: true, syncRound: 2 }))).toEqual([]);
  });

  test("同一角色被多人猜过只出现一次", () => {
    const guesses = [guess("a", 1), guess("b", 1)];
    expect(bannedCharacterIdsFor(guesses, context())).toEqual([1]);
  });
});

describe("隐藏标签遮蔽", () => {
  const sample = {
    id: "g",
    playerId: "other",
    playerName: "别人",
    character: { id: 1, name: "甲", nameCn: "甲", imageUrl: undefined },
    correct: false,
    partial: false,
    syncRound: 1,
    createdAt: 1,
    feedback: {
      tags: [
        { text: "校园", matched: true, hidden: false, kind: "subject" },
        { text: "黑发", matched: true, hidden: false, kind: "character" },
      ],
    },
  } as unknown as CEEGuess;

  test("被隐藏的标签统一占位且不泄露命中，其余原样", () => {
    const masked = maskGuessTags(sample, (text) => text === "校园");
    expect(masked.feedback.tags).toEqual([
      { text: "???", matched: false, hidden: true, kind: "subject" },
      { text: "黑发", matched: true, hidden: false, kind: "character" },
    ]);
    expect(sample.feedback.tags[0]?.text).toBe("校园");
  });
});
