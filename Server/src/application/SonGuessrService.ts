import { isAudioTicketMatch } from "./songuessr/AudioTicket";
import {
  COMMAND_RATE_LIMIT_PER_CONNECTION,
  COMMAND_RATE_LIMIT_WINDOW_MS,
} from "../config/Constants";
import { ADMIN_CLOSE_REASON, AdminRoomView } from "../domain/AdminRoom";
import type { GameService } from "./GameService";
import {
  SERVER_SHUTDOWN_MESSAGE,
  SonGuessrClientMessage,
  SonGuessrRoomSummary,
  type ConnectionRecord,
} from "../shared/Index";
import { type SnapshottedRoom } from "../shared/RoomSnapshot";
import type { SonGuessrServiceOptions } from "./songuessr/Options";
import { createSonGuessrContext, type SonGuessrContext } from "./songuessr/Context";
import { listRoomSummaries } from "./songuessr/RoomViews";
import { isTestRoom, requireRoomPlayer } from "./songuessr/RoomAccess";
import { createSonGuessrCommands, type SonGuessrDispatcher } from "./songuessr/Commands";
import { CommandQuota, dispatchCommand } from "./room/CommandTable";
import { closeRoom } from "./songuessr/RoomClosure";
import { runHousekeeping } from "./songuessr/Housekeeping";
import { adminKickPlayer, disconnectSeat } from "./songuessr/Membership";
import { exportSnapshots, restoreSnapshots } from "./songuessr/SnapshotCodec";

import { adminRoomView, countOnline, requireAdminRoom } from "./room/RoomSummaries";
import { assertTabAgentsAllowed, roomsOfTab } from "./room/SeatBinding";
import { musicIpScope } from "../infrastructure/music/MusicIpScope";
import { createEvent } from "../transport/Packets";
import { SonGuessrRoomRecord } from "./songuessr/Records";

export class SonGuessrService implements GameService<SonGuessrClientMessage> {
  readonly ctx: SonGuessrContext;
  private readonly dispatcher: SonGuessrDispatcher;
  /** 每连接的命令总额度：任何命令都先扣它，音乐、封面与登录的按成本配额在它之后。 */
  private readonly commandQuota: CommandQuota;

  constructor(readonly options: SonGuessrServiceOptions) {
    this.ctx = createSonGuessrContext(options);
    const { ctx } = this;
    this.commandQuota = new CommandQuota({
      now: () => ctx.now(),
      windowMs: COMMAND_RATE_LIMIT_WINDOW_MS,
      maxRequests: COMMAND_RATE_LIMIT_PER_CONNECTION,
    });
    this.dispatcher = {
      table: createSonGuessrCommands(ctx),
      deps: { ctx },
      resolveSeat: (connection) => {
        const { room, player } = requireRoomPlayer(ctx, connection);
        return { room, seat: player };
      },
      isRoomRegistered: (room) => ctx.rooms.get(room.id) === room,
      isSeated: (room, seat) => room.players[seat.id] === seat,
      hostIdOf: (room) => room.hostPlayerId,
      phaseOf: (room) => room.phase,
    };
  }

  /** 房间表：测试直接读它，写入只走命令与巡检。 */
  get rooms(): Map<string, SonGuessrRoomRecord> {
    return this.ctx.rooms;
  }

  /**
   * 站内播放地址的跳转目标：按房号与票据取当前回合保存在服务端的上游地址。
   * 房间不在、没有进行中的回合、票据不符都返回 undefined，调用方不得把三者区分开来回给客户端。
   * 目标只来自回合记录，不接受任何请求里的地址。
   */
  resolveAudioRedirect(roomId: string, ticket: string): string | undefined {
    const round = this.ctx.rooms.get(roomId)?.currentRound;
    if (!round || !isAudioTicketMatch(ticket, round.audioTicket)) return undefined;
    return round.song.audioUrl || undefined;
  }

  getRoomSummaries(): SonGuessrRoomSummary[] {
    return listRoomSummaries(this.ctx);
  }

  registerConnection(connection: ConnectionRecord): void {
    this.ctx.connections.registerConnection(connection);
  }

  getHealthSnapshot() {
    return {
      roomCount: this.ctx.rooms.size,
      connectionCount: this.ctx.connections.stats.totalConnections,
      onlinePlayerCount: [...this.ctx.rooms.values()].reduce(
        (sum, room) => sum + countOnline(Object.values(room.players)),
        0
      ),
    };
  }

  notifyShutdown(): void {
    this.ctx.connections.broadcastToAll(
      createEvent("server.shutdown", {
        message: SERVER_SHUTDOWN_MESSAGE,
      })
    );
  }

  /** 导出全部房间以供停机保存；两类字段不落盘的理由见快照编解码模块。 */
  exportSnapshots(): SnapshottedRoom[] {
    return exportSnapshots(this.ctx);
  }

  /** 从快照恢复房间，返回真正恢复的房间数。 */
  restoreSnapshots(rooms: readonly SnapshottedRoom[], savedAt: number): number {
    return restoreSnapshots(this.ctx, rooms, savedAt);
  }

  async unregisterConnection(connectionId: string): Promise<void> {
    return disconnectSeat(this.ctx, connectionId);
  }

  async runHousekeeping(): Promise<void> {
    return runHousekeeping(this.ctx);
  }

  async execute(connectionId: string, message: SonGuessrClientMessage): Promise<unknown> {
    const connection = this.ctx.connections.getConnection(connectionId);
    // 总额度排在一切之前，与卧底、猜猜呗同一个窗口与额度。
    this.commandQuota.consume(connection);
    // 玩家级伪装 IP 归属：同一连接的匿名请求复用同一个 CN IP，不同玩家各持一个，
    // 避免全服匿名请求共享同一份网易云限流配额（见 NeteaseMusicProvider 的 musicIpScope）。
    // 作用域只能在最外层建立，下游 provider 才可能在任意调用深度读到玩家身份。
    return musicIpScope.run(`player:${connectionId}`, async () =>
      dispatchCommand(this.dispatcher, connection, message)
    );
  }

  adminListRooms(): AdminRoomView[] {
    return [...this.ctx.rooms.values()].map((room) =>
      adminRoomView(room, Object.values(room.players), {
        game: "song",
        name: room.name,
        phase: room.phase,
        visibility: room.visibility,
        hidden: isTestRoom(this.ctx, room) || room.solo,
        roundNumber: room.roundNumber,
      })
    );
  }

  async adminCloseRoom(roomId: string): Promise<void> {
    closeRoom(this.ctx, requireAdminRoom(this.ctx.rooms, roomId), ADMIN_CLOSE_REASON);
  }

  async adminKickPlayer(roomId: string, playerId: string): Promise<void> {
    return adminKickPlayer(this.ctx, roomId, playerId);
  }

  /** 这张标签页要交给 Agent：它坐着的房间必须开着 MCP，否则其他玩家的知情就被绕过了。 */
  assertTabAgentsAllowed(tabKey: string): void {
    assertTabAgentsAllowed(this.ctx.kernel, tabKey);
  }

  /** 接管开始或结束：同房玩家要立刻看到座位上的 MCP 徽标变化。 */
  publishTabRooms(tabKey: string): void {
    for (const room of roomsOfTab(this.ctx.kernel, tabKey)) this.ctx.publishRoom(room);
  }
}
