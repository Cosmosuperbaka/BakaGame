import { AppError } from "../domain/Errors";
import type { CEEPlayerRecord, CEERoom } from "../domain/CEEModel";
import { canStartCEERound, surrenderCEE } from "../domain/CEERound";
import { validateCEESettings } from "../domain/CEERules";
import type { TestRoomPolicy } from "../domain/TestRooms";
import type { CEEPhase } from "../shared/CEE";
import type { CEERoomClientMessage } from "../shared/Index";
import { runCEEDataCommand } from "./CEEDataCommands";
import { approveSpectate, requestSpectate } from "./CEERoomSpectate";
import {
  cancelCEEPreparation,
  chooseCEESetter,
  requestCEEImageHint,
  startCEEGame,
  submitCEEAnswer,
  submitCEEGuess,
  type CEENativeContext,
} from "./CEENativeRoundActions";
import type {
  CommandDispatcher,
  CommandResult,
  CommandTable,
  Guard,
  PhaseRule,
} from "./room/CommandTable";

/** 增强房处理的命令：大厅订阅由统一入口 `CEEService` 先行处理，不会下沉到这里。 */
export type CEENativeMessage = Exclude<CEERoomClientMessage, { type: "cee.lobby.subscribeRooms" }>;

export type CEENativeCommandTable = CommandTable<
  CEENativeMessage,
  CEENativeContext,
  CEERoom,
  CEEPlayerRecord,
  CEEPhase
>;

export type CEENativeDispatcher = CommandDispatcher<
  CEENativeMessage,
  CEENativeContext,
  CEERoom,
  CEEPlayerRecord,
  CEEPhase
>;

const phaseRule = (
  allow: readonly CEEPhase[],
  message: string,
  code = "INVALID_PHASE"
): PhaseRule<CEEPhase> => ({ allow, code, message });

/** 只在等待阶段允许：设置、准备、组队、旁观与目录导入共用这一条。 */
const WAITING_ONLY = phaseRule(["waiting"], "请在等待阶段修改");

/** 关闭作品搜索的那一局里，正在猜题的玩家不能靠搜索绕过题目线索。 */
const subjectSearchAllowed: Guard<CEERoom, CEEPlayerRecord> = ({ room, seat }) => {
  if (room.phase === "guessing" && !room.settings.subjectSearch && seat.status === "playing")
    throw new AppError("SUBJECT_SEARCH_DISABLED", "本局关闭了作品搜索");
};

/** 出题阶段只认当前出题人；阶段不对与不是出题人是同一个错误。 */
const isCurrentSetter: Guard<CEERoom, CEEPlayerRecord> = ({ room, seat }) => {
  if (room.setterPlayerId !== seat.id) throw new AppError("NOT_SETTER", "仅当前出题人可以提交答案");
};

/**
 * 进房结果与目录导入结果是接口类型，没有索引签名，不能直接赋给命令结果的 `Record`；
 * 响应形状由 `CEEResponse` 约定，这里只在表里统一放行，不改变运行时的值。
 */
const asResult = (value: unknown) => value as CommandResult | Promise<CommandResult>;

/**
 * 增强房命令表。每条命令的守卫按「房主 → 阶段 → 玩法守卫」的固定顺序执行（由内核分发器保证），
 * 与改表之前各处理函数开头手写检查的先后一致；同时违反两条时拿到哪个错误码由这个顺序决定。
 * 跨 await 的命令保留各自在 await 之后的复核（局、同步轮、次数、截止），错误码各不相同，不并入统一复核。
 * 测试房策略只影响「能否开局」，由工厂注入。
 */
export const createCEENativeCommands = (testRooms: TestRoomPolicy): CEENativeCommandTable => ({
  "cee.room.create": {
    access: "lobby",
    run: (ctx, connection, message) => asResult(ctx.state.createRoom(connection, message.payload)),
  },
  "cee.room.join": {
    access: "lobby",
    run: (ctx, connection, message) =>
      asResult(ctx.state.joinRoom(connection, message.roomId, message.payload)),
  },
  "cee.room.reconnect": {
    access: "lobby",
    run: (ctx, connection, message) => {
      const result = ctx.state.reconnectRoom(connection, message.payload);
      ctx.rescheduleAll();
      return asResult(result);
    },
  },
  "cee.room.leave": {
    access: "seat",
    phases: "any",
    run: (ctx, { connection, room, seat }) => ctx.state.leaveRoom(connection, room, seat),
  },
  "cee.room.requestSync": {
    access: "seat",
    phases: "any",
    run: (_ctx, { connection }) => {
      connection.resetStateSync?.();
    },
  },
  "cee.room.settings": {
    access: "host",
    phases: WAITING_ONLY,
    run: (ctx, { room }, message) => {
      validateCEESettings(message.payload.settings);
      // 反作弊那一位由建房决定，`applySettings` 会把它换回房里的现值：中途改不了。
      ctx.state.applySettings(room, message.payload.settings);
    },
  },
  "cee.room.update": {
    access: "host",
    phases: WAITING_ONLY,
    run: (ctx, { room, seat }, message) => ctx.state.updateSettings(room, seat, message.payload),
  },
  // 房主没有准备态：开局权在房主手里，准备与否对他没有意义，界面也不显示准备按钮。
  "cee.player.ready": {
    access: "seat",
    phases: WAITING_ONLY,
    run: (_ctx, { room, seat }, message) => {
      if (seat.id !== room.hostPlayerId) seat.ready = message.payload.ready;
    },
  },
  "cee.player.team": {
    access: "seat",
    phases: WAITING_ONLY,
    run: (_ctx, { seat }, message) => {
      seat.team = message.payload.team;
    },
  },
  "cee.player.spectate": {
    access: "seat",
    phases: WAITING_ONLY,
    run: (ctx, { room, seat }, message) => {
      const pending = requestSpectate(ctx.state, room, seat, message.payload.spectator);
      return { pending, membership: seat.membership };
    },
  },
  "cee.player.approveSpectate": {
    access: "host",
    phases: "any",
    run: (ctx, { room, seat }, message) => {
      approveSpectate(ctx.state, room, message.payload.playerId, message.payload.approved);
      return { pending: false, membership: seat.membership };
    },
  },
  "cee.room.kick": {
    access: "host",
    phases: "any",
    run: (ctx, { room, seat }, message) => ctx.state.kick(room, seat, message.payload.playerId),
  },
  "cee.room.transferHost": {
    access: "host",
    phases: "any",
    run: (ctx, { room, seat }, message) =>
      ctx.state.transferHost(room, seat, message.payload.playerId),
  },
  "cee.chat.send": {
    access: "seat",
    phases: "any",
    run: (ctx, { room, seat }, message) => ctx.state.sendChat(room, seat, message.payload.text),
  },
  "cee.character.search": {
    access: "seat",
    phases: "any",
    run: (ctx, _at, message) =>
      asResult(runCEEDataCommand(ctx.data, message.type, message.payload)),
  },
  "cee.subject.search": {
    access: "seat",
    phases: "any",
    guards: [subjectSearchAllowed],
    run: (ctx, _at, message) =>
      asResult(runCEEDataCommand(ctx.data, message.type, message.payload)),
  },
  "cee.subject.characters": {
    access: "seat",
    phases: "any",
    guards: [subjectSearchAllowed],
    run: (ctx, _at, message) =>
      asResult(runCEEDataCommand(ctx.data, message.type, message.payload)),
  },
  "cee.subject.lookup": {
    access: "seat",
    phases: "any",
    run: (ctx, _at, message) =>
      asResult(runCEEDataCommand(ctx.data, message.type, message.payload)),
  },
  "cee.directory.import": {
    access: "host",
    phases: WAITING_ONLY,
    run: (ctx, _at, message) =>
      asResult(runCEEDataCommand(ctx.data, message.type, message.payload)),
  },
  "cee.character.image": {
    access: "seat",
    phases: "any",
    run: (ctx, _at, message) =>
      asResult(runCEEDataCommand(ctx.data, message.type, message.payload)),
  },
  "cee.subject.image": {
    access: "seat",
    phases: "any",
    run: (ctx, _at, message) =>
      asResult(runCEEDataCommand(ctx.data, message.type, message.payload)),
  },
  "cee.game.start": {
    access: "host",
    phases: phaseRule(["waiting", "settled"], "当前阶段无法开始游戏"),
    guards: [
      ({ room, seat }) => {
        if (!canStartCEERound(room, seat, testRooms))
          throw new AppError("PLAYERS_NOT_READY", "至少两名玩家在线，且其他参与者准备后才能开始");
      },
    ],
    run: (ctx, { room }) => startCEEGame(ctx, room),
  },
  "cee.game.chooseSetter": {
    access: "host",
    phases: phaseRule(["choosingSetter"], "请先开始游戏再指定出题人"),
    run: (ctx, { room }, message) => chooseCEESetter(ctx, room, message.payload.playerId),
  },
  "cee.game.setAnswer": {
    access: "seat",
    phases: phaseRule(["answering"], "仅当前出题人可以提交答案", "NOT_SETTER"),
    guards: [isCurrentSetter],
    run: (ctx, { room, seat }, message) =>
      submitCEEAnswer(ctx, room, seat, message.payload.characterId, message.payload.hints),
  },
  "cee.game.cancel": {
    access: "host",
    phases: phaseRule(["choosingSetter", "answering", "preparing"], "当前没有等待中的出题任务"),
    run: (ctx, { room }) => cancelCEEPreparation(ctx, room),
  },
  "cee.game.guess": {
    access: "seat",
    phases: "any",
    run: (ctx, { connection, room, seat }, message) =>
      submitCEEGuess(ctx, connection, room, seat, message.payload.characterId),
  },
  "cee.game.surrender": {
    access: "seat",
    phases: "any",
    run: (ctx, { room, seat }) => {
      surrenderCEE(room, seat, ctx.now());
    },
  },
  "cee.game.next": {
    access: "host",
    phases: phaseRule(["settled"], "请等待本局结束"),
    run: (ctx, { room }) => ctx.state.resetWaiting(room),
  },
  "cee.game.imageHint": {
    access: "seat",
    phases: "any",
    run: (ctx, { room, seat }) => requestCEEImageHint(ctx, room, seat),
  },
});
