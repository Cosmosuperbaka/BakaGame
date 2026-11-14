/**
 * 「房间已结束」类事件（关闭、被移出、席位被接管）的统一口径。
 *
 * 事件里的房号可能不是当前展示的房间：旧房间的席位被替代、重连后晚到的关闭事件。
 * 这类过期事件只能清掉它所指房间的本地令牌，不能退掉当前房间；
 * 当前没有已确认的房间（含入房请求还在途中）时，事件一律按指向当事房间处理。
 */
/**
 * 结束类提示：三款同一语义同一句。只有 CEE 原版房改用上游给的句子——那是原版服务器的说法，
 * 增强版这边没有更准确的版本；增强房与另两款一样用这里的句子。
 */
export const ROOM_ENDED_TEXT = {
  closed: "房间已关闭",
  kicked: "你已被移出房间",
  replaced: "当前席位已在另一个标签页接管",
} as const;

export interface EndedRoomTarget {
  /** 要清理令牌的房间；事件与当前都没有房号时为 null。 */
  roomId: string | null;
  /** 事件指向另一间房：只清它的令牌，不动当前房间与在途入房。 */
  foreign: boolean;
}

export function resolveEndedRoom(
  eventRoomId: string | null | undefined,
  currentRoomId: string | null | undefined
): EndedRoomTarget {
  const roomId = eventRoomId || currentRoomId || null;
  return {
    roomId,
    foreign: Boolean(eventRoomId && currentRoomId && eventRoomId !== currentRoomId),
  };
}
