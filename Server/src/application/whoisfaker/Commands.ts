import { AppError, unsupportedCommand } from "../../domain/Errors";
import { assertTextAllowed } from "../../infrastructure/SensitiveText";
import type {
  WhoIsFakerPhase,
  WhoIsFakerPlayerRecord,
  WhoIsFakerRoomRecord,
} from "../../shared/Index";
import type { WhoIsFakerClientMessage } from "../../transport/WhoIsFakerProtocol";
import type { WhoIsFakerService } from "../WhoIsFakerService";
import type { CommandDispatcher, CommandTable, Guard } from "../room/CommandTable";
import { resolveDisconnect } from "./OfflineSettlement";
import { advancePhase } from "./PhaseFlow";
import { startPhaseTimer, stopPhaseTimer } from "./PhaseTimers";
import {
  enterBlankGuess,
  reviewBlankGuess,
  submitBlankGuess,
  updateBlankGuessDraft,
} from "./BlankGuess";
import { sendChat } from "./Chat";
import type { WhoIsFakerContext } from "./Context";
import {
  assignQuestioner,
  cancelNightAction,
  cancelVote,
  requestSupplement,
  submitDescription,
  submitNightAction,
  submitVote,
  submitWords,
} from "./RoundCommands";
import { renamePlayer, setReady, setSpectator } from "./PlayerCommands";
import {
  ensureHost,
  ensureQuestioner,
  isRoundActive,
  phaseOf,
  requireRoomPlayer,
  requireRound,
} from "./RoomAccess";
import { testAddBot, testJumpToPhase, testRemoveBot, testSetMyRole } from "./dev/TestControls";

/**
 * 仍在服务门面里的命令处理：它们牵涉房间生命周期、出题、发言与投票，随服务拆分后续迁出，
 * 这里的成员会换成模块函数。命令表只依赖这一小块窄接口。
 */
type RoomHandlers = Pick<
  WhoIsFakerService,
  | "createRoom"
  | "joinRoom"
  | "reconnectRoom"
  | "leaveRoom"
  | "requestSync"
  | "updateSettings"
  | "kick"
  | "transferHost"
>;

interface WhoIsFakerCommandDeps {
  readonly ctx: WhoIsFakerContext;
  readonly handlers: RoomHandlers;
}

type WhoIsFakerCommandTable = CommandTable<
  WhoIsFakerClientMessage,
  WhoIsFakerCommandDeps,
  WhoIsFakerRoomRecord,
  WhoIsFakerPlayerRecord,
  WhoIsFakerPhase
>;

export type WhoIsFakerDispatcher = CommandDispatcher<
  WhoIsFakerClientMessage,
  WhoIsFakerCommandDeps,
  WhoIsFakerRoomRecord,
  WhoIsFakerPlayerRecord,
  WhoIsFakerPhase
>;

type RoomGuard = Guard<WhoIsFakerRoomRecord, WhoIsFakerPlayerRecord>;

const fail =
  (code: string, message: string) =>
  (condition: boolean): void => {
    if (condition) throw new AppError(code, message);
  };

/** 已经开局：没有回合时与别的玩法判定同码，排在阶段与出题人判定之前。 */
const roundStarted: RoomGuard = ({ room }) => {
  requireRound(room);
};

/** 出题人专属：回合存在，且发起人就是本局出题人。 */
const questionerOnly: RoomGuard = ({ room, seat }) => {
  ensureQuestioner(requireRound(room), seat.id);
};

/** 测试房放开给房内任何人，其余房间只认出题人。 */
const questionerUnlessTestRoom =
  (ctx: WhoIsFakerContext): RoomGuard =>
  (at) => {
    if (!ctx.testRooms.isTestRoom(at.room.id)) questionerOnly(at);
  };

const hostOnly: RoomGuard = ({ room, seat }) => {
  ensureHost(room, seat.id);
};

/** 回合空闲才行：等待阶段与结算阶段可以，其余阶段（回合进行中）一律拒绝。 */
const roundIdle =
  (message: string): RoomGuard =>
  ({ room }) =>
    fail("ROUND_ACTIVE", message)(isRoundActive(room));

/** 被移出的记录只是等待清理的占位，不能再改自己的状态。 */
const notKicked: RoomGuard = ({ seat }) =>
  fail("PLAYER_KICKED", "该玩家已被移出房间")(seat.membership === "kicked");

/**
 * 阶段必须在允许集合内。顺序夹在「回合存在」与「出题人」之间的命令，
 * 阶段不能放进固定的「阶段」位置，所以写成玩法守卫，列表里的先后就是旧处理函数里的先后。
 */
const inPhase =
  (allow: readonly WhoIsFakerPhase[], message: string): RoomGuard =>
  ({ room }) =>
    fail("INVALID_PHASE", message)(!allow.includes(phaseOf(room)));

/** 阶段不能落在拒绝集合内：用于「除了几个阶段都可以」的命令。 */
const phaseNotIn =
  (rejected: readonly WhoIsFakerPhase[], message: string): RoomGuard =>
  ({ room }) =>
    fail("INVALID_PHASE", message)(rejected.includes(phaseOf(room)));

/**
 * 测试指令的第一道守卫：先问策略。
 * 非测试房（含策略关闭）一律当作协议里没有这条指令，与未知指令同码同文案，
 * 不给探测者区分「开关关了」与「这间房不是测试房」的信号。
 */
const testRoomOnly =
  (ctx: WhoIsFakerContext): RoomGuard =>
  ({ room }) => {
    if (!ctx.testRooms.isTestRoom(room.id)) unsupportedCommand();
  };

/**
 * 先于座位解析的参数预检：这三条命令的旧处理函数把参数判定排在认座位之前，
 * 未入房的连接带着非法参数拿到的是参数错误而不是未入房。
 * 由门面的入口在分发之前调用，其余命令没有预检。
 */
export const screenCommand = (message: WhoIsFakerClientMessage): void => {
  switch (message.type) {
    case "game.submitBlankGuess":
    case "game.updateBlankGuessDraft":
      assertTextAllowed(message.payload.words[0], message.payload.words[1]);
      return;
    case "game.startPhaseTimer": {
      const seconds = message.payload.durationSeconds;
      if (seconds !== 60 && seconds !== 120 && seconds !== 180) {
        throw new AppError("INVALID_ARGUMENT", "倒计时时长只能在1、2、3分钟之间选择");
      }
      return;
    }
    default:
      return;
  }
};

/**
 * 卧底命令表。每条命令的守卫按「房主 → 阶段 → 玩法守卫」的固定顺序执行（由内核分发器保证）；
 * 卧底的阶段判定都夹在别的判定之间，所以 `phases` 一律不限，阶段写成玩法守卫，
 * 列表里的先后就是旧处理函数里的先后。
 *
 * 不进守卫列表、留在处理函数里的检查，都是为了保住旧的时机：
 * - 依赖载荷的判定（词语、描述、目标玩家）；
 * - 推进阶段按当前阶段分叉（房主、出题人或测试房任意人），所以整个判定留在函数里；
 * - 跨 await 之后的复核各有各的错误码，不并入统一复核；
 * - 处理函数开头取回合是为了收窄类型，守卫已经保证它存在。
 */
export const createWhoIsFakerCommands = (ctx: WhoIsFakerContext): WhoIsFakerCommandTable => ({
  "lobby.subscribeRooms": {
    access: "lobby",
    run: (deps, connection) => {
      connection.lobbySubscribed = true;
      // 只回给这条连接：向全服重发一遍等价于「N 人同时打开大厅 = N×N 帧」，
      // 而新来的玩家要的只是自己那份列表。
      deps.ctx.lobbyFanout.sendTo(connection);
      return { subscribed: true };
    },
  },
  "room.create": {
    access: "lobby",
    run: (deps, connection, m) => deps.handlers.createRoom(connection, m),
  },
  "room.join": {
    access: "lobby",
    run: (deps, connection, m) => deps.handlers.joinRoom(connection, m),
  },
  "room.reconnect": {
    access: "lobby",
    run: (deps, connection, m) => deps.handlers.reconnectRoom(connection, m),
  },
  "room.leave": {
    access: "seat",
    phases: "any",
    run: (deps, at) => deps.handlers.leaveRoom(at),
  },
  "room.requestSync": {
    access: "seat",
    phases: "any",
    run: (deps, at) => deps.handlers.requestSync(at),
  },
  "room.updateSettings": {
    access: "host",
    phases: "any",
    guards: [roundIdle("游戏进行中无法修改房间设置")],
    run: (deps, at, m) => deps.handlers.updateSettings(at, m.payload),
  },
  "room.kick": {
    access: "host",
    phases: "any",
    run: (deps, at, m) => deps.handlers.kick(at, m.payload.playerId),
  },
  "room.transferHost": {
    access: "host",
    phases: "any",
    run: (deps, at, m) => deps.handlers.transferHost(at, m.payload.playerId),
  },
  "chat.send": {
    access: "seat",
    phases: "any",
    run: (deps, at, m) => sendChat(deps.ctx, at, m.payload.text),
  },
  "player.rename": {
    access: "seat",
    phases: "any",
    run: (deps, at, m) => renamePlayer(deps.ctx, at, m.payload.name),
  },
  "player.setSpectator": {
    access: "seat",
    phases: "any",
    guards: [notKicked, roundIdle("游戏进行中无法切换阵营")],
    run: (deps, at, m) => setSpectator(deps.ctx, at, m.payload.spectator),
  },
  "player.setReady": {
    access: "seat",
    phases: "any",
    guards: [roundIdle("游戏进行中无法切换准备状态")],
    run: (deps, at, m) => setReady(deps.ctx, at, m.payload.ready),
  },
  "game.assignQuestioner": {
    access: "host",
    phases: "any",
    guards: [roundStarted, inPhase(["assigningQuestioner"], "当前阶段不能指定出题人")],
    run: (deps, at, m) => assignQuestioner(deps.ctx, at, m.payload.playerId),
  },
  "game.submitWords": {
    access: "seat",
    phases: "any",
    guards: [questionerOnly, inPhase(["wordSubmission"], "当前阶段不能提交词语")],
    run: (deps, at, m) =>
      submitWords(deps.ctx, at, m.payload.words, m.payload.blankHint, m.payload.manualRoles),
  },
  "game.advancePhase": {
    access: "seat",
    phases: "any",
    run: (deps, at) => advancePhase(deps.ctx, at),
  },
  "game.submitDescription": {
    access: "seat",
    phases: "any",
    guards: [roundStarted],
    run: (deps, at, m) => submitDescription(deps.ctx, at, m.payload.text),
  },
  "game.submitVote": {
    access: "seat",
    phases: "any",
    guards: [roundStarted],
    run: (deps, at, m) => submitVote(deps.ctx, at, m.payload.targetId),
  },
  "game.submitNightAction": {
    access: "seat",
    phases: "any",
    guards: [roundStarted, inPhase(["night"], "当前阶段不能提交夜晚操作")],
    run: (deps, at, m) => submitNightAction(deps.ctx, at, m.payload.targetId),
  },
  "game.submitBlankGuess": {
    access: "seat",
    phases: "any",
    guards: [roundStarted],
    run: (deps, at, m) => submitBlankGuess(deps.ctx, at, m.payload.words),
  },
  "game.enterBlankGuess": {
    access: "seat",
    phases: "any",
    guards: [roundStarted],
    run: (deps, at) => enterBlankGuess(deps.ctx, at),
  },
  "game.updateBlankGuessDraft": {
    access: "seat",
    phases: "any",
    guards: [roundStarted],
    run: (deps, at, m) => updateBlankGuessDraft(deps.ctx, at, m.payload.words),
  },
  "game.reviewBlankGuess": {
    access: "seat",
    phases: "any",
    guards: [questionerOnly],
    run: (deps, at, m) => reviewBlankGuess(deps.ctx, at, m.payload.approve),
  },
  "game.cancelVote": {
    access: "seat",
    phases: "any",
    guards: [roundStarted],
    run: (deps, at) => cancelVote(deps.ctx, at),
  },
  "game.cancelNightAction": {
    access: "seat",
    phases: "any",
    guards: [roundStarted, inPhase(["night"], "当前阶段不能撤销夜晚操作")],
    run: (deps, at) => cancelNightAction(deps.ctx, at),
  },
  "game.requestSupplement": {
    access: "seat",
    phases: "any",
    guards: [questionerOnly],
    run: (deps, at, m) => requestSupplement(deps.ctx, at, m.payload.playerIds),
  },
  "game.resolveDisconnect": {
    access: "seat",
    phases: "any",
    guards: [questionerOnly],
    run: (deps, at, m) => resolveDisconnect(deps.ctx, at, m.payload.playerId, m.payload.resolution),
  },
  "game.startPhaseTimer": {
    access: "seat",
    phases: "any",
    guards: [
      roundStarted,
      phaseNotIn(
        ["assigningQuestioner", "wordSubmission", "feedback", "gameOver"],
        "当前阶段不支持设置倒计时"
      ),
      questionerUnlessTestRoom(ctx),
    ],
    run: (deps, at, m) => startPhaseTimer(deps.ctx, at, m.payload.durationSeconds),
  },
  "game.stopPhaseTimer": {
    access: "seat",
    phases: "any",
    guards: [roundStarted, questionerUnlessTestRoom(ctx)],
    run: (deps, at) => stopPhaseTimer(deps.ctx, at),
  },
  // 测试指令：先问策略、再验房主。房主判定写成玩法守卫而不是 `access: "host"`，
  // 因为内核分发器的房主判定排在所有玩法守卫之前，会让非测试房里的非房主先拿到「只有房主」，
  // 给探测者留下区分信号。机器人当不了房主，所以没有「房主是机器人」的例外。
  "test.jumpToPhase": {
    access: "seat",
    phases: "any",
    guards: [testRoomOnly(ctx), hostOnly],
    run: (deps, at, m) => testJumpToPhase(deps.ctx, at, m.payload.phase),
  },
  "test.setMyRole": {
    access: "seat",
    phases: "any",
    guards: [testRoomOnly(ctx), hostOnly],
    run: (deps, at, m) => testSetMyRole(deps.ctx, at, m.payload.role),
  },
  "test.addBot": {
    access: "seat",
    phases: "any",
    guards: [testRoomOnly(ctx), hostOnly],
    run: (deps, at, m) => testAddBot(deps.ctx, at, m.payload.count ?? 1),
  },
  "test.removeBot": {
    access: "seat",
    phases: "any",
    guards: [testRoomOnly(ctx), hostOnly],
    run: (deps, at, m) => testRemoveBot(deps.ctx, at, m.payload.playerId, m.payload.count ?? 1),
  },
});

export const createWhoIsFakerDispatcher = (
  ctx: WhoIsFakerContext,
  handlers: RoomHandlers
): WhoIsFakerDispatcher => ({
  table: createWhoIsFakerCommands(ctx),
  deps: { ctx, handlers },
  resolveSeat: (connection) => {
    const { room, player } = requireRoomPlayer(ctx, connection);
    return { room, seat: player };
  },
  isRoomRegistered: (room) => ctx.rooms.get(room.id) === room,
  // 只认「仍在名册」：被移出的记录仍算座位，由各命令自己的守卫决定怎么拒绝（如切换旁观先报被移出）。
  isSeated: (room, seat) => room.players[seat.id] === seat,
  hostIdOf: (room) => room.hostPlayerId,
  phaseOf,
});
