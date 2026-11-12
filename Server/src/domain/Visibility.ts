/**
 * 「谁能看到回合秘密」（答案、身份表、他人的私密作答）的唯一判定。
 *
 * 三款视图过去各写一条布尔表达式，口径各不相同，泄漏就出在其中最宽的那一条上。
 * 规则：出题一方始终可见（秘密本来就是他给的）；回合结束后秘密随结算公开，全员可见；
 * 局中的旁观者只有在房间开启「旁观可见答案」时才可见；其余局中参与者一律不可见。
 * 「可以进场旁观」与「旁观能看到多少」是两件事，前者不蕴含后者。
 */
export interface RoundSecretViewer {
  /** 本回合的出题一方：出题人本人，以及按玩法规则与出题人同看答案、本回合不作答的人。 */
  setsRound: boolean;
  /** 以旁观身份在场。 */
  spectator: boolean;
}

export const canSeeRoundSecrets = (
  viewer: RoundSecretViewer,
  roundActive: boolean,
  spectatorsSeeAnswers: boolean
): boolean => {
  if (viewer.setsRound || !roundActive) return true;
  return viewer.spectator && spectatorsSeeAnswers;
};
