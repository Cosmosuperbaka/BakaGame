import type { SpeechMode, WhoIsFakerRoomSnapshot } from "@bakagame/shared";

type SpeechStatus = WhoIsFakerRoomSnapshot["status"];

/** 普通描述时服务端不下发 speechMode，按阶段回退，PK 阶段的语气仍是 PK。 */
export const speechModeOf = (status: SpeechStatus): SpeechMode =>
  status.speechMode ?? (status.phase === "tieBreak" ? "tieBreak" : "normal");

/** 发言阶段服务端总会下发 speechOrder，它是当前这一列的唯一定义，无需回退。 */
export const speechOrderOf = (status: SpeechStatus): readonly string[] => status.speechOrder ?? [];

/** 已提交名单同样由服务端随发言阶段下发，不从发言记录反推。 */
export const submittedOf = (status: SpeechStatus): Set<string> =>
  new Set(status.submittedSpeechPlayerIds ?? []);
