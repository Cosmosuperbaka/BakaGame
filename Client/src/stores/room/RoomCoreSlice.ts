/** 三款房间 store 共有的连接与房间字段；玩法自己的字段在各自接口里追加。 */
export interface RoomCoreState<TSummary, TSnapshot, TPrivate> {
  connected: boolean;
  /** 本次连接的大厅是否已就绪；断线复位。大厅据此区分「加载中」与「暂无房间」。 */
  lobbyReady: boolean;
  rooms: TSummary[];
  roomId: string | null;
  sessionToken: string | null;
  snapshot: TSnapshot | null;
  privateState: TPrivate | null;
  /**
   * 房间被服务端关闭的时刻。房间页据此立刻退回大厅：
   * 关闭是一次明确的服务端事件，不能靠「没有快照」这种同时也匹配初次挂载的推断来判断。
   */
  roomClosedAt: number | null;
  /** 清掉「房间已结束」标记；页面挂载与卸载时各调一次，避免旧标记把下次进入立刻弹回大厅。 */
  clearRoomClosed: () => void;
}

export function createRoomCoreSlice<TSummary, TSnapshot, TPrivate>(
  set: (patch: Partial<RoomCoreState<TSummary, TSnapshot, TPrivate>>) => void
): RoomCoreState<TSummary, TSnapshot, TPrivate> {
  return {
    connected: false,
    lobbyReady: false,
    rooms: [],
    roomId: null,
    sessionToken: null,
    snapshot: null,
    privateState: null,
    roomClosedAt: null,
    clearRoomClosed: () => set({ roomClosedAt: null }),
  };
}
