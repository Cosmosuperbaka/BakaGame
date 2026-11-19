import type { SpeechMode, WhoIsFakerRoomSnapshot } from "@bakagame/shared";

type SpeechStatus = WhoIsFakerRoomSnapshot["status"];

/** 发言模式由服务端在任何阶段下发，客户端不按阶段回退。 */
export const speechModeOf = (status: SpeechStatus): SpeechMode => status.speechMode;

/** 当前这一列的完整顺序，非发言阶段为空数组。 */
export const speechOrderOf = (status: SpeechStatus): readonly string[] => status.speechOrder;

/** 已提交名单由服务端下发，不从发言记录反推。 */
export const submittedOf = (status: SpeechStatus): Set<string> =>
  new Set(status.submittedSpeechPlayerIds);
