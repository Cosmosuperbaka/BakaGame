import { AppError } from "../../domain/Errors";
import type { SonGuessrClientMessage, SonGuessrPhase } from "../../shared/Index";
import type { SonGuessrService } from "../SonGuessrService";
import type { CommandDispatcher, CommandTable, Guard, PhaseRule } from "../room/CommandTable";
import {
  checkMusicQrLogin,
  clearMusicAccount,
  createMusicQrLogin,
  setPoolSharing,
  useMusicCookie,
} from "./MusicAuth";
import {
  getAnimeSongs,
  getSubjectImage,
  resolvePlaylist,
  searchArtists,
  searchBangumi,
  searchMusic,
} from "./MusicCommands";
import { sendChat } from "./Chat";
import { addBots, removeBots } from "./dev/TestBots";
import type { SonGuessrContext } from "./Context";
import type { SonGuessrPlayerRecord, SonGuessrRoomRecord } from "./Records";
import { isRoomStarting, isTestRoom } from "./RoomAccess";
import { audioFailed, audioReady, giveUp, guess, guessAnime, skipRound } from "./RoundEngine";

/**
 * 仍在服务门面里的命令处理：它们牵涉回合、计分与选歌，随回合逻辑后续拆出后，
 * 这里的成员会换成模块函数。表只依赖这一小块窄接口。
 */
type RoomHandlers = Pick<
  SonGuessrService,
  | "createRoom"
  | "joinRoom"
  | "reconnectRoom"
  | "leaveRoom"
  | "requestSync"
  | "setReady"
  | "setSpectator"
  | "setTeam"
  | "updateSettings"
  | "kick"
  | "transferHost"
  | "startGame"
  | "chooseSubmitter"
  | "getSongClipPreview"
  | "submitSong"
  | "submitAnime"
  | "nextRound"
  | "finishGame"
>;

export interface SonGuessrCommandDeps {
  readonly ctx: SonGuessrContext;
  readonly handlers: RoomHandlers;
}

export type SonGuessrCommandTable = CommandTable<
  SonGuessrClientMessage,
  SonGuessrCommandDeps,
  SonGuessrRoomRecord,
  SonGuessrPlayerRecord,
  SonGuessrPhase
>;

export type SonGuessrDispatcher = CommandDispatcher<
  SonGuessrClientMessage,
  SonGuessrCommandDeps,
  SonGuessrRoomRecord,
  SonGuessrPlayerRecord,
  SonGuessrPhase
>;

/**
 * 二维码登录的结果是接口类型，没有索引签名，不能直接赋给命令结果的 `Record`；
 * 响应形状由协议约定，这里只在表里统一放行，不改变运行时的值。
 */
const asResult = (value: Promise<unknown>) => value as Promise<Record<string, unknown>>;

type RoomGuard = Guard<SonGuessrRoomRecord, SonGuessrPlayerRecord>;

const phaseRule = (
  allow: readonly SonGuessrPhase[],
  message: string
): PhaseRule<SonGuessrPhase> => ({ allow, code: "INVALID_PHASE", message });

const fail =
  (code: string, message: string) =>
  (condition: boolean): void => {
    if (condition) throw new AppError(code, message);
  };

/** 开局在途（自动加载或手动开局中）：阶段仍是等待，但设置与开局不能再动。 */
const notStarting =
  (message: string): RoomGuard =>
  ({ room }) =>
    fail("INVALID_PHASE", message)(isRoomStarting(room));

/** 阶段不在允许集合内：用于顺序夹在别的守卫中间、不能放进固定「阶段」位置的命令。 */
const inPhase =
  (allow: readonly SonGuessrPhase[], message: string): RoomGuard =>
  ({ room }) =>
    fail("INVALID_PHASE", message)(!allow.includes(room.phase));

const activeMemberOnly =
  (message: string): RoomGuard =>
  ({ seat }) =>
    fail("SPECTATOR_FORBIDDEN", message)(seat.membership !== "active");

const notSolo: RoomGuard = ({ room }) => fail("SOLO_ROOM_FORBIDDEN", "单人房间没有队伍")(room.solo);

const pendingSubmitterOnly =
  (message: string): RoomGuard =>
  ({ room, seat }) =>
    fail(
      "NOT_SUBMITTER",
      message
    )(room.phase !== "submittingSong" || room.pendingSubmitterPlayerId !== seat.id);

const customClipAllowed: RoomGuard = ({ room }) =>
  fail("CUSTOM_CLIP_DISABLED", "本房间未开放自选片段")(room.settings.allowCustomClip === false);

const animeQuestionOnly: RoomGuard = ({ room }) =>
  fail("INVALID_QUESTION_TYPE", "当前房间不是听歌猜番模式")(room.settings.questionType !== "anime");

/** 测试指令只在测试房里受理；要看策略，所以需要上下文，由工厂注入。 */
const testRoomOnly =
  (ctx: SonGuessrContext): RoomGuard =>
  ({ room }) =>
    fail("TEST_ROOM_ONLY", "该指令仅用于测试房间")(!isTestRoom(ctx, room));

/**
 * 猜歌命令表。每条命令的守卫按「房主 → 阶段 → 玩法守卫」的固定顺序执行（由内核分发器保证）；
 * 顺序夹在别的检查中间的命令，把阶段也写成玩法守卫，列表里的先后就是旧处理函数里的先后。
 *
 * 不进守卫列表、留在处理函数里的检查，都是为了保住旧的时机：
 * - 音乐配额要扣额度，必须排在所有守卫之后、由各处理函数开头调用；
 * - 「当前没有进行中的回合」要顺手取回合对象收窄类型，留在猜测类处理函数开头；
 * - 账号共享开关只认自动开局加载中，口径与 `notStarting` 不同，留在函数里；
 * - 跨 await 之后的复核各有各的错误码，不并入统一复核。
 */
export const createSonGuessrCommands = (ctx: SonGuessrContext): SonGuessrCommandTable => ({
  "song.lobby.subscribeRooms": {
    access: "lobby",
    run: (deps, connection) => {
      connection.lobbySubscribed = true;
      // 只给这条连接发当前列表：合并窗下全量广播可能刚刚发过，
      // 新订阅者不能因为「还在窗内」而一份列表都拿不到。
      deps.ctx.lobby.sendTo(connection);
      return { subscribed: true };
    },
  },
  "song.room.create": {
    access: "lobby",
    run: (deps, connection, m) => deps.handlers.createRoom(connection, m.payload),
  },
  "song.room.join": {
    access: "lobby",
    run: (deps, connection, m) => deps.handlers.joinRoom(connection, m.roomId, m.payload),
  },
  "song.room.reconnect": {
    access: "lobby",
    run: (deps, connection, m) =>
      deps.handlers.reconnectRoom(connection, m.payload.roomId, m.payload.sessionToken),
  },
  "song.room.leave": {
    access: "seat",
    phases: "any",
    run: (deps, at) => deps.handlers.leaveRoom(at),
  },
  "song.room.requestSync": {
    access: "seat",
    phases: "any",
    run: (deps, at) => deps.handlers.requestSync(at),
  },
  "song.player.setReady": {
    access: "seat",
    phases: phaseRule(["waiting"], "只能在等待阶段准备"),
    guards: [activeMemberOnly("旁观者不能准备")],
    run: (deps, at, m) => deps.handlers.setReady(at, m.payload.ready),
  },
  "song.player.setSpectator": {
    access: "seat",
    phases: "any",
    run: (deps, at, m) => deps.handlers.setSpectator(at, m.payload.spectator),
  },
  "song.player.setTeam": {
    access: "seat",
    phases: "any",
    guards: [
      notSolo,
      inPhase(["waiting"], "只能在等待阶段更换队伍"),
      activeMemberOnly("旁观者没有队伍"),
    ],
    run: (deps, at, m) => deps.handlers.setTeam(at, m.payload.team),
  },
  "song.room.updateSettings": {
    access: "host",
    phases: phaseRule(["waiting"], "只能在等待阶段修改房间设置"),
    guards: [notStarting("只能在等待阶段修改房间设置")],
    run: (deps, at, m) => deps.handlers.updateSettings(at, m.payload),
  },
  "song.room.kick": {
    access: "host",
    phases: "any",
    run: (deps, at, m) => deps.handlers.kick(at, m.payload.playerId),
  },
  "song.room.transferHost": {
    access: "host",
    phases: "any",
    run: (deps, at, m) => deps.handlers.transferHost(at, m.payload.playerId),
  },
  "song.chat.send": {
    access: "seat",
    phases: "any",
    run: (deps, at, m) => sendChat(deps.ctx, at, m.payload.text),
  },
  "song.auth.qr.create": {
    access: "seat",
    phases: "any",
    run: (deps, at, m) =>
      asResult(createMusicQrLogin(deps.ctx, at, m.payload.platform, m.payload.type)),
  },
  "song.auth.qr.check": {
    access: "seat",
    phases: "any",
    run: (deps, at, m) =>
      checkMusicQrLogin(deps.ctx, at, m.payload.key, m.payload.platform, m.payload.type),
  },
  "song.auth.useCookie": {
    access: "seat",
    phases: "any",
    run: (deps, at, m) => useMusicCookie(deps.ctx, at, m.payload.cookie, m.payload.platform),
  },
  "song.auth.clear": {
    access: "seat",
    phases: "any",
    run: (deps, at, m) => clearMusicAccount(deps.ctx, at, m.payload.platform),
  },
  "song.auth.setPoolSharing": {
    access: "seat",
    phases: "any",
    run: (deps, at, m) => setPoolSharing(deps.ctx, at, m.payload.platform, m.payload.enabled),
  },
  "song.music.search": {
    access: "seat",
    phases: "any",
    run: (deps, at, m) => searchMusic(deps.ctx, at, m.payload.keyword),
  },
  "song.music.detail": {
    access: "seat",
    phases: "any",
    guards: [pendingSubmitterOnly("只有当前出题人可以预览歌曲"), customClipAllowed],
    run: (deps, at, m) =>
      deps.handlers.getSongClipPreview(
        at,
        m.payload.songId,
        m.payload.sources,
        m.payload.requiresVip
      ),
  },
  "song.music.playlist.resolve": {
    access: "seat",
    phases: "any",
    run: (deps, at, m) => resolvePlaylist(deps.ctx, at, m.payload.value),
  },
  "song.music.artist.search": {
    access: "seat",
    phases: "any",
    run: (deps, at, m) => searchArtists(deps.ctx, at, m.payload.keyword),
  },
  "song.bangumi.search": {
    access: "seat",
    phases: "any",
    run: (deps, _at, m) => searchBangumi(deps.ctx, m.payload.keyword),
  },
  "song.bangumi.songs": {
    access: "seat",
    phases: "any",
    run: (deps, at, m) => getAnimeSongs(deps.ctx, at, m.payload.subjectId),
  },
  "song.subject.image": {
    access: "seat",
    phases: "any",
    run: (deps, at, m) => getSubjectImage(deps.ctx, at, m.payload.subjectId),
  },
  "song.game.start": {
    access: "host",
    phases: phaseRule(["waiting"], "当前不能开始新游戏"),
    guards: [notStarting("当前不能开始新游戏")],
    run: (deps, at) => deps.handlers.startGame(at),
  },
  "song.game.chooseSubmitter": {
    access: "host",
    phases: phaseRule(["choosingSubmitter"], "当前不能选择出题人"),
    run: (deps, at, m) => deps.handlers.chooseSubmitter(at, m.payload.playerId),
  },
  "song.game.submitSong": {
    access: "seat",
    phases: "any",
    guards: [pendingSubmitterOnly("只有当前出题人可以提交歌曲")],
    run: (deps, at, m) =>
      deps.handlers.submitSong(
        at,
        m.payload.songId,
        m.payload.clip,
        m.payload.sources,
        m.payload.requiresVip
      ),
  },
  "song.game.submitAnime": {
    access: "seat",
    phases: "any",
    guards: [animeQuestionOnly, pendingSubmitterOnly("只有当前出题人可以提交番剧")],
    run: (deps, at, m) => deps.handlers.submitAnime(at, m.payload.subjectId, m.payload.songId),
  },
  "song.game.audioReady": {
    access: "seat",
    phases: "any",
    run: (deps, at, m) => audioReady(deps.ctx, at, m.payload.roundNumber),
  },
  "song.game.audioFailed": {
    access: "seat",
    phases: "any",
    run: (deps, at, m) => audioFailed(deps.ctx, at, m.payload.roundNumber),
  },
  "song.game.guess": {
    access: "seat",
    phases: "any",
    run: (deps, at, m) => guess(deps.ctx, at, m.payload.songId),
  },
  "song.game.guessAnime": {
    access: "seat",
    phases: "any",
    run: (deps, at, m) => guessAnime(deps.ctx, at, m.payload.subjectId),
  },
  "song.game.giveUp": {
    access: "seat",
    phases: "any",
    run: (deps, at) => giveUp(deps.ctx, at),
  },
  "song.game.skipRound": {
    access: "host",
    phases: "any",
    run: (deps, at) => skipRound(deps.ctx, at),
  },
  "song.game.nextRound": {
    access: "host",
    phases: phaseRule(["roundResult"], "当前不在回合结算阶段"),
    run: (deps, at) => deps.handlers.nextRound(at),
  },
  "song.game.finish": {
    access: "host",
    phases: phaseRule(["roundResult"], "只能在回合结算后返回等待阶段"),
    run: (deps, at) => deps.handlers.finishGame(at),
  },
  "song.test.addBot": {
    access: "host",
    phases: "any",
    guards: [testRoomOnly(ctx)],
    run: (deps, at, m) => addBots(deps.ctx, at, m.payload.count),
  },
  "song.test.removeBot": {
    access: "host",
    phases: "any",
    guards: [testRoomOnly(ctx)],
    run: (deps, at, m) => removeBots(deps.ctx, at, m.payload.count),
  },
});
