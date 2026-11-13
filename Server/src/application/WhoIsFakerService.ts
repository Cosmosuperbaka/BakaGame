import { type AdminRoomView } from "../domain/AdminRoom";
import {
  type ConnectionRecord,
  type WhoIsFakerPlayerRecord,
  type WhoIsFakerRoomRecord,
  type WhoIsFakerRoomSummary,
  SERVER_SHUTDOWN_MESSAGE,
} from "../shared/Index";
import type { SnapshottedRoom } from "../shared/RoomSnapshot";
import type { GameService } from "./GameService";

import { createEvent } from "../transport/Packets";
import type { WhoIsFakerClientMessage } from "../transport/WhoIsFakerProtocol";

import {
  COMMAND_RATE_LIMIT_PER_CONNECTION,
  COMMAND_RATE_LIMIT_WINDOW_MS,
} from "../config/Constants";
import { assertTabAgentsAllowed, roomsOfTab, type TabSeatContext } from "./room/SeatBinding";
import { whoIsFakerShape } from "./whoisfaker/RoomShape";
import {
  createWhoIsFakerDispatcher,
  screenCommand,
  type WhoIsFakerDispatcher,
} from "./whoisfaker/Commands";
import { CommandQuota, dispatchCommand } from "./room/CommandTable";
import { createWhoIsFakerContext, type WhoIsFakerContext } from "./whoisfaker/Context";
import type { WhoIsFakerServiceOptions } from "./whoisfaker/Options";
import { handlePlayerOffline } from "./whoisfaker/OfflineSettlement";
import {
  adminCloseRoom,
  adminKickPlayer,
  adminListRooms,
  getHealthSnapshot,
} from "./whoisfaker/AdminView";
import { runHousekeeping } from "./whoisfaker/Housekeeping";
import { exportSnapshots, restoreSnapshots } from "./whoisfaker/SnapshotPersistence";
import { handlePhaseTimeout } from "./whoisfaker/PhaseTimeouts";
import { publishRoom } from "./whoisfaker/RoomPublish";
import { listRoomSummaries } from "./whoisfaker/RoomViews";

export class WhoIsFakerService implements GameService<WhoIsFakerClientMessage> {
  // ==================== 房间与状态机总控 ====================

  /** 上下文：数据与叶子工具都在这里，子模块只拿它，不拿门面。 */
  readonly ctx: WhoIsFakerContext;
  /** 标签页接管 Agent 时按标签页找房间用的上下文。 */
  private readonly tabSeats: TabSeatContext<WhoIsFakerRoomRecord, WhoIsFakerPlayerRecord>;
  private readonly dispatcher: WhoIsFakerDispatcher;
  /** 每连接的命令总额度：在预检、解析与守卫之前扣，高频乱发的连接在最便宜的地方被挡住。 */
  private readonly commandQuota: CommandQuota;

  /** 房间表的只读视图：测试与外部只读它，写入只经上下文里的玩法函数。 */
  get rooms(): ReadonlyMap<string, WhoIsFakerRoomRecord> {
    return this.ctx.rooms;
  }

  constructor(options: WhoIsFakerServiceOptions) {
    this.ctx = createWhoIsFakerContext(
      options,
      (roomId, expectedPhase, expectedSpeechMode, expectedTieBreakStage) =>
        handlePhaseTimeout(
          this.ctx,
          roomId,
          expectedPhase,
          expectedSpeechMode,
          expectedTieBreakStage
        )
    );
    const ctx = this.ctx;
    this.tabSeats = {
      shape: whoIsFakerShape,
      connections: ctx.connectionRegistry,
      rooms: ctx.rooms,
    };
    this.dispatcher = createWhoIsFakerDispatcher(ctx);
    this.commandQuota = new CommandQuota({
      now: () => ctx.now(),
      windowMs: COMMAND_RATE_LIMIT_WINDOW_MS,
      maxRequests: COMMAND_RATE_LIMIT_PER_CONNECTION,
    });
  }

  registerConnection(connection: ConnectionRecord): void {
    this.ctx.connectionRegistry.registerConnection(connection);
  }

  // 连接断开时只做连接解绑，真正的房间副作用统一交给 handlePlayerOffline。
  async unregisterConnection(connectionId: string): Promise<void> {
    const connection = this.ctx.connectionRegistry.unregisterConnection(connectionId);

    if (!connection || !connection.roomId || !connection.playerId) {
      return;
    }

    const room = this.ctx.rooms.get(connection.roomId);

    if (!room) {
      return;
    }

    const player = room.players[connection.playerId];
    // 非座席主连接断开，不影响座位在线态。
    if (player?.connectionId !== connection.id) return;

    await handlePlayerOffline(this.ctx, room, connection.playerId, "disconnect");
  }

  async execute(connectionId: string, message: WhoIsFakerClientMessage): Promise<unknown> {
    // 所有命令都从这里进入，方便统一做连接上下文解析与后续审计。
    const connection = this.ctx.connectionRegistry.getConnection(connectionId);
    // 额度排在预检之前：预检里有敏感词扫描，高频草稿不该先白白扫一遍再被限流。
    this.commandQuota.consume(connection);
    screenCommand(message);
    return dispatchCommand(this.dispatcher, connection, message);
  }

  async runHousekeeping(): Promise<void> {
    await runHousekeeping(this.ctx);
  }

  notifyShutdown(): void {
    this.ctx.connectionRegistry.broadcastToAll(
      createEvent("server.shutdown", {
        message: SERVER_SHUTDOWN_MESSAGE,
      })
    );
  }

  exportSnapshots(): SnapshottedRoom[] {
    return exportSnapshots(this.ctx);
  }

  restoreSnapshots(rooms: readonly SnapshottedRoom[], savedAt: number): number {
    return restoreSnapshots(this.ctx, rooms, savedAt);
  }

  getHealthSnapshot() {
    return getHealthSnapshot(this.ctx);
  }

  getRoomSummaries(): WhoIsFakerRoomSummary[] {
    return listRoomSummaries(this.ctx);
  }

  adminListRooms(): AdminRoomView[] {
    return adminListRooms(this.ctx);
  }

  async adminCloseRoom(roomId: string): Promise<void> {
    await adminCloseRoom(this.ctx, roomId);
  }

  async adminKickPlayer(roomId: string, playerId: string): Promise<void> {
    await adminKickPlayer(this.ctx, roomId, playerId);
  }

  /** 这张标签页要交给 Agent：它坐着的房间必须开着 MCP，否则其他玩家的知情就被绕过了。 */
  assertTabAgentsAllowed(tabKey: string): void {
    assertTabAgentsAllowed(this.tabSeats, tabKey);
  }

  /** 接管开始或结束：同房玩家要立刻看到座位上的 MCP 徽标变化。 */
  publishTabRooms(tabKey: string): void {
    for (const room of roomsOfTab(this.tabSeats, tabKey)) publishRoom(this.ctx, room);
  }

  async drainPendingWrites(): Promise<void> {
    await this.ctx.options.wordBankRepository?.drainWrites();
  }
}
