import type {
  WhoIsFakerPhase,
  WhoIsFakerRoomRecord,
  WhoIsFakerRoomSnapshot,
} from "../../shared/Index";

/** 反馈标题按结算来源分四类，其余情况按普通投票结果。 */
const feedbackResultLabel = (feedback: WhoIsFakerRoomSnapshot["status"]["feedback"]): string => {
  if (feedback?.kind === "night") return "夜晚结果";
  if (feedback?.kind === "blankGuess") return "白板猜词结果";
  return feedback?.tieBreak ? "平票投票结果" : "投票结果";
};

const questionerDisplayName = (
  snapshot: WhoIsFakerRoomSnapshot,
  room: WhoIsFakerRoomRecord
): string => {
  const questionerId = snapshot.status.questionerPlayerId;
  return (questionerId ? room.players[questionerId]?.name : undefined) ?? "出题人";
};

/** 阶段切换提示文案；未登记的阶段回落到「已进入\<phase\>」。 */
const PHASE_CHANGE_DESCRIPTIONS: Partial<
  Record<WhoIsFakerPhase, (snapshot: WhoIsFakerRoomSnapshot, room: WhoIsFakerRoomRecord) => string>
> = {
  waiting: () => "已返回房间中",
  assigningQuestioner: (_snapshot, room) => `第 ${room.roundCount ?? 1} 轮游戏已开始`,
  wordSubmission: (snapshot, room) => `${questionerDisplayName(snapshot, room)}正在出题`,
  description: (snapshot) =>
    `第 ${snapshot.status.day} 天${snapshot.status.speechMode === "supplement" ? "补充描述" : "描述"}阶段`,
  voting: (snapshot) => `第 ${snapshot.status.day} 天投票阶段`,
  tieBreak: (snapshot) =>
    `第 ${snapshot.status.day} 天${snapshot.status.tieBreakStage === "vote" ? "平票投票" : "平票描述"}阶段`,
  night: (snapshot) => `第 ${snapshot.status.day} 天夜晚阶段`,
  blankGuess: (snapshot) => `第 ${snapshot.status.day} 天白板猜词阶段`,
  feedback: (snapshot) =>
    `第 ${snapshot.status.day} 天${feedbackResultLabel(snapshot.status.feedback)}`,
  gameOver: (snapshot) => `第 ${snapshot.status.day} 天游戏结算阶段`,
};

export const describePhaseChange = (
  snapshot: WhoIsFakerRoomSnapshot,
  room: WhoIsFakerRoomRecord
): string => {
  const phase = snapshot.status.phase;
  const describe = PHASE_CHANGE_DESCRIPTIONS[phase];
  return describe ? describe(snapshot, room) : `已进入${phase}`;
};

/** 阶段播报的去重键：键变了才算进入了新的阶段或子阶段。 */
export const getPhaseNoticeKey = (snapshot: WhoIsFakerRoomSnapshot): string => {
  const { phase, day, speechMode, tieBreakStage, supplementIndex } = snapshot.status;
  return [phase, day, speechMode, tieBreakStage, supplementIndex].join(":");
};
