import type { CEEGuess } from "../shared/CEE";

/**
 * 全局 BP 与隐藏标签遮蔽的单一规则来源：增强房的提交校验、增强房与原版房的私有视图都调这里，
 * 规则演进时只改一处，两种房对同一份猜测给出同一口径。
 */

/** 判定所需的房间设置与视角：谁在看、全局 BP 是否开启、同步轮口径。 */
export interface CEEPickContext {
  playerId: string;
  globalPick: boolean;
  syncMode: boolean;
  nonstopMode: boolean;
  /** 当前同步轮号；非同步模式下不参与判定。 */
  syncRound: number;
}

type CEEPickGuess = Pick<CEEGuess, "playerId" | "syncRound" | "correct"> & {
  character: Pick<CEEGuess["character"], "id">;
};

/**
 * 全局 BP 下该玩家视角的禁用角色编号：其他玩家猜过的角色。
 * 本人重复提交不算违规；同步模式只看往轮；答案在同步与血战下豁免（猜中它的那条不计入）。
 */
export function bannedCharacterIdsFor(
  guesses: readonly CEEPickGuess[],
  context: CEEPickContext
): number[] {
  if (!context.globalPick) return [];
  const mine = new Set(
    guesses
      .filter((guess) => guess.playerId === context.playerId)
      .map((guess) => guess.character.id)
  );
  const answerExempt = context.syncMode || context.nonstopMode;
  return [
    ...new Set(
      guesses
        .filter(
          (guess) =>
            guess.playerId !== context.playerId &&
            !mine.has(guess.character.id) &&
            (!context.syncMode || guess.syncRound < context.syncRound) &&
            !(answerExempt && guess.correct)
        )
        .map((guess) => guess.character.id)
    ),
  ];
}

/** 提交校验：该角色对这位玩家是否处于禁用状态，与视图里下发的禁用名单同一口径。 */
export function isCharacterBanned(
  guesses: readonly CEEPickGuess[],
  context: CEEPickContext,
  characterId: number
): boolean {
  return bannedCharacterIdsFor(guesses, context).includes(characterId);
}

/** 隐藏标签的占位文案：两种房统一，客户端按 hidden 标记渲染，不显示这段文字。 */
const HIDDEN_TAG_TEXT = "???";

/** 按谓词遮蔽猜测里的标签：被隐藏的标签既不给文字也不给命中标志。 */
export function maskGuessTags(guess: CEEGuess, isHidden: (tagText: string) => boolean): CEEGuess {
  return {
    ...guess,
    feedback: {
      ...guess.feedback,
      tags: guess.feedback.tags.map((tag) =>
        isHidden(tag.text)
          ? { text: HIDDEN_TAG_TEXT, matched: false, hidden: true, kind: tag.kind }
          : tag
      ),
    },
  };
}
