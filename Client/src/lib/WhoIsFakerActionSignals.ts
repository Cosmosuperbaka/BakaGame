import { getPageControl } from "@/stores/UsePageControl";
import type { WhoIsFakerPrivateState, WhoIsFakerRoomSnapshot } from "@bakagame/shared";

/**
 * 本地玩家当前是否有一项必须由自己发起的操作。玩法规则由服务端算进 canAct，
 * 这里只叠加「页面被托管时不提醒」这条本地状态。恢复现场不算新提醒。
 */
export function whoIsFakerNeedsAction(
  snapshot: WhoIsFakerRoomSnapshot | null,
  privateState: WhoIsFakerPrivateState | null
): boolean {
  if (!snapshot || !privateState || getPageControl().status === "controlled") return false;
  return privateState.canAct;
}
