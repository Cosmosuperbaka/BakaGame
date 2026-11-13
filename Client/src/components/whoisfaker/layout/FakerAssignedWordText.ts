import type { WhoIsFakerPrivateState } from "@bakagame/shared";

/** 玩家可见的自己那份词：天使拿到两个候选，白板只拿到提示。 */
const angelOrBlankWordText = (
  privateState: WhoIsFakerPrivateState | null | undefined
): string | undefined => {
  if (privateState?.angelWordOptions)
    return `天使：${privateState.angelWordOptions[0]}/${privateState.angelWordOptions[1]}`;
  return privateState?.blankHint ? `白板提示：${privateState.blankHint}` : undefined;
};

export const resolveAssignedWordText = (
  privateState: WhoIsFakerPrivateState | null | undefined,
  isSpectator: boolean
): string | undefined => {
  if (isSpectator || privateState?.isQuestioner) return undefined;
  return privateState?.word ?? angelOrBlankWordText(privateState);
};
