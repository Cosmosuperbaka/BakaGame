/**
 * 「房间已结束」类事件（关闭、被移出、席位被接管）的统一口径。
 *
 * 事件里的房号可能不是当前展示的房间：旧房间的席位被替代、重连后晚到的关闭事件。
 * 这类过期事件只能清掉它所指房间的本地令牌，不能退掉当前房间；
 * 当前没有已确认的房间（含入房请求还在途中）时，事件一律按指向当事房间处理。
 */
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
