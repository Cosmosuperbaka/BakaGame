import { Type as t, type Static } from '@sinclair/typebox';
import { Value } from '@sinclair/typebox/value';
import type { ChatMessage, RoomVisibility } from './Model';
import type { ClientEnvelope } from './Protocol';

const strict = { additionalProperties: false } as const;
const integer = (minimum: number, maximum: number) => t.Integer({ minimum, maximum });
export const CCBSettingsSchema = t.Object({
  startYear: integer(1900, 2200), endYear: integer(1900, 2200),
  topNSubjects: integer(1, 1000), useSubjectPerYear: t.Boolean(),
  metaTags: t.Array(t.String({ maxLength: 40 }), { maxItems: 3 }),
  useIndex: t.Boolean(), indexId: t.Union([integer(1, 2147483647), t.Null()]),
  addedSubjects: t.Array(integer(1, 2147483647), { maxItems: 500 }),
  mainCharacterOnly: t.Boolean(), characterNum: integer(1, 100),
  maxAttempts: integer(1, 100), timeLimit: integer(0, 120),
  subjectSearch: t.Boolean(), subjectTagNum: integer(0, 10), characterTagNum: integer(0, 10),
  commonTags: t.Boolean(), useHints: t.Array(integer(0, 100), { maxItems: 3 }),
  useImageHint: integer(0, 100), globalPick: t.Boolean(), tagBan: t.Boolean(),
  syncMode: t.Boolean(), nonstopMode: t.Boolean(),
}, strict);
export type CCBSettings = Static<typeof CCBSettingsSchema>;
export function parseCCBSettings(value: unknown): CCBSettings {
  if (!Value.Check(CCBSettingsSchema, value)) throw new Error('设置文件格式不正确');
  return value;
}
export const createDefaultCCBSettings = (year = new Date().getFullYear()): CCBSettings => ({
  startYear: year - 5, endYear: year, topNSubjects: 20, useSubjectPerYear: false,
  metaTags: ['', '', ''], useIndex: false, indexId: null, addedSubjects: [],
  mainCharacterOnly: true, characterNum: 6, maxAttempts: 10, timeLimit: 60,
  subjectSearch: true, subjectTagNum: 4, characterTagNum: 4, commonTags: true,
  useHints: [], useImageHint: 0, globalPick: false, tagBan: false, syncMode: false, nonstopMode: false,
});
export type CCBSource = 'native' | 'original';
export type CCBPhase = 'waiting' | 'preparing' | 'answering' | 'guessing' | 'settled';
export interface CCBCharacterSummary { id: number; name: string; nameCn: string; imageUrl?: string }
export interface CCBAppearance { id: number; name: string; nameCn: string; year: number; rating: number; ratingCount: number }
export type CCBComparisonAppearance = Pick<CCBAppearance, 'id' | 'name' | 'nameCn'>;
export interface CCBExtraTagSection { section: string; tags: string[] }
export interface CCBCharacterView extends CCBCharacterSummary {
  gender: 'male' | 'female' | '?'; popularity: number; summary: string;
  appearances: CCBAppearance[]; highestRating: number; earliestAppearance: number; latestAppearance: number;
  subjectTags: string[]; characterTags: string[]; voiceActors: string[]; metaTags: string[];
  comparisonAppearances: CCBComparisonAppearance[];
  extraTags: CCBExtraTagSection[];
}
export interface CCBSubjectSummary { id: number; name: string; nameCn: string; type: number; year: number | null; rating: number; heat: number }
export interface CCBDirectoryResult { id: number; subjectIds: number[]; missingSubjectIds: number[]; importedAt: number }
export type CCBComparison = '=' | '+' | '++' | '-' | '--' | '?' | 'yes' | 'no';
export interface CCBFeedbackValue { value: number | string; comparison: CCBComparison }
export interface CCBFeedback {
  gender: CCBFeedbackValue; popularity: CCBFeedbackValue; rating: CCBFeedbackValue;
  appearancesCount: CCBFeedbackValue; earliestAppearance: CCBFeedbackValue; latestAppearance: CCBFeedbackValue;
  sharedAppearances: CCBComparisonAppearance[];
  tags: Array<{ text: string; matched: boolean; hidden: boolean; kind: 'subject' | 'character' | 'voice' }>;
  extraTags: Array<{ section: string; tags: Array<{ text: string; matched: boolean }> }>;
}
export interface CCBGuess {
  id: string; playerId: string; playerName: string; character: CCBCharacterSummary;
  correct: boolean; partial: boolean; syncRound: number; createdAt: number; feedback: CCBFeedback;
}
export type CCBPlayerStatus = 'waiting' | 'playing' | 'solved' | 'teamWon' | 'exhausted' | 'surrendered' | 'observing';
export interface CCBPlayer {
  id: string; name: string; online: boolean; ready: boolean; team: number | null;
  membership: 'active' | 'spectator'; score: number; status: CCBPlayerStatus;
  attempts: number; marks: string; syncCompleted: boolean;
}
export interface CCBScoreDetail {
  playerId: string; playerName: string; score: number; base: number; firstGuess: number;
  quickGuess: number; partial: number; setter: number; reason: string; rank?: number;
}
export interface CCBRoundSummary {
  answer: CCBCharacterView; scores: CCBScoreDetail[]; guesses: CCBGuess[];
  winners: Array<{ playerId: string; rank: number; score: number }>;
}
export interface CCBRoomSnapshot {
  roomId: string; source: CCBSource; name: string; visibility: RoomVisibility; hasPassword: boolean;
  allowSpectators: boolean; hostPlayerId: string; phase: CCBPhase; settings: CCBSettings;
  players: CCBPlayer[]; roundNumber: number; syncRound: number; setterPlayerId: string | null;
  phaseDeadlineAt: number | null; chat: ChatMessage[]; roundSummary: CCBRoundSummary | null;
  upstreamConnected: boolean;
}
export interface CCBPrivateState {
  playerId: string; canGuess: boolean; canSurrender: boolean; canStart: boolean; canSetAnswer: boolean;
  setterCandidateIds: string[];
  guesses: CCBGuess[]; answer: CCBCharacterView | null; hints: string[];
  imageHintAvailable: boolean; imageHintLevel: number; deadlineAt: number | null;
  bannedCharacterIds: number[];
}
/**
 * 大厅房间条目。`roomId` 是统一的 4 位房号（原版客户端建的 UUID 房为服务端分配的别名）。
 * `playerCount` 只计参与玩家；原版列表不提供旁观人数，`spectatorCount` 为 `null`，界面不得显示为 0。
 */
export interface CCBRoomSummary {
  roomId: string; source: CCBSource; name: string; phase: CCBPhase; playerCount: number;
  spectatorCount: number | null; hasPassword: boolean; allowSpectators: boolean;
}
export interface CCBRoomEnterResult { roomId: string; source: CCBSource; sessionToken: string; snapshot: CCBRoomSnapshot; privateState: CCBPrivateState }
const empty = t.Object({}, strict);
const source = t.Union([t.Literal('native'), t.Literal('original')]);
const name = t.String({ minLength: 1, maxLength: 32 });
/**
 * 可选载荷字段必须显式接纳 `null`。
 *
 * 前端把「没有密码」「没有会话凭据」表示为 `null` 而非省略字段，`JSON.stringify`
 * 会原样保留 `null`，而 `t.Optional()` 只接受字段缺席。若只写 `t.Optional`，
 * 这类合法请求会被判成 `INVALID_MESSAGE` 并返回 400。
 */
const optionalPassword = t.Optional(t.Union([t.String({ maxLength: 64 }), t.Null()]));
/**
 * 会话凭据在「已失效」与「尚未取得」之间是可恢复状态，不能用 schema 直接拒绝。
 *
 * 前端 `reconnectRoom` 会把 sessionStorage 里的凭据原样放进载荷；凭据为空串
 * （存储被清、写入竞态、跨标签页竞争）或字段缺失时，若 schema 要求
 * `minLength: 1`，请求在**解析阶段**就被判非法——表现为 400 且日志只剩 `WS raw`，
 * 连是哪个命令都看不出来，客户端还会因错误包 id 不匹配而完全静默。
 * 这里放开为空/缺席，交由业务层用 `SESSION_EXPIRED` 明确拒绝，错误可归因。
 */
const recoverySessionToken = t.Optional(t.Union([t.String({ maxLength: 128 }), t.Null()]));
const playerId = t.String({ minLength: 1, maxLength: 128 });
const roomId = t.String({ minLength: 1, maxLength: 32 });
const id = integer(1, 2147483647);
export const CCBPayloadSchemas = {
  'ccb.lobby.subscribeRooms': empty,
  'ccb.room.create': t.Object({ source, roomId, name, userName: name,
    visibility: t.Union([t.Literal('public'), t.Literal('private')]),
    password: optionalPassword, allowSpectators: t.Boolean() }, strict),
  // 进入已有房间只凭统一房号，来源由服务端的房号目录判定；只有建房需要声明建在哪个服务器。
  'ccb.room.join': t.Object({ userName: name, password: optionalPassword }, strict),
  'ccb.room.reconnect': t.Object({ roomId, sessionToken: recoverySessionToken }, strict),
  'ccb.room.leave': empty, 'ccb.room.requestSync': empty,
  // 切到私密时 `password` 给新密码；留空或缺席表示沿用已有密码。转为公开会清除密码。
  'ccb.room.update': t.Object({ name, visibility: t.Union([t.Literal('public'), t.Literal('private')]),
    allowSpectators: t.Boolean(), password: optionalPassword }, strict),
  'ccb.room.settings': t.Object({ settings: CCBSettingsSchema }, strict),
  'ccb.player.ready': t.Object({ ready: t.Boolean() }, strict),
  'ccb.player.team': t.Object({ team: t.Union([integer(1, 8), t.Null()]) }, strict),
  'ccb.player.spectate': t.Object({ spectator: t.Boolean() }, strict),
  'ccb.room.kick': t.Object({ playerId }, strict), 'ccb.room.transferHost': t.Object({ playerId }, strict),
  'ccb.chat.send': t.Object({ text: t.String({ minLength: 1, maxLength: 500 }) }, strict),
  'ccb.character.search': t.Object({ keyword: t.String({ minLength: 1, maxLength: 80 }) }, strict),
  'ccb.subject.search': t.Object({ keyword: t.String({ minLength: 1, maxLength: 80 }) }, strict),
  'ccb.subject.characters': t.Object({ subjectId: id }, strict),
  'ccb.directory.import': t.Object({ indexId: id }, strict),
  'ccb.character.image': t.Object({ characterId: id }, strict),
  'ccb.game.start': empty,
  'ccb.game.chooseSetter': t.Object({ playerId }, strict),
  'ccb.game.setAnswer': t.Object({ characterId: id, hints: t.Array(t.String({ maxLength: 30 }), { maxItems: 3 }) }, strict),
  'ccb.game.cancel': empty,
  'ccb.game.guess': t.Object({ characterId: id }, strict),
  'ccb.game.surrender': empty, 'ccb.game.next': empty,
  'ccb.game.imageHint': empty,
} as const;
export type CCBCommand = keyof typeof CCBPayloadSchemas;
export type CCBPayload<T extends CCBCommand> = Static<(typeof CCBPayloadSchemas)[T]>;
export type CCBClientMessage = { [K in CCBCommand]: ClientEnvelope<K, CCBPayload<K>> }[CCBCommand];
export const CCB_STATE_EVENTS = ['ccb.room.snapshot', 'ccb.game.privateState'] as const;

/** 线路信封接纳 null；进入业务层前统一规范化为可选字符串。 */
const optionalEnvelopeString = (maxLength: number) =>
  t.Optional(t.Union([t.String({ maxLength }), t.Null()]));
const createCCBMessageSchema = <K extends CCBCommand>(type: K) => t.Object({
  id: t.String({ minLength: 1, maxLength: 128 }), traceId: optionalEnvelopeString(128),
  type: t.Literal(type), roomId: optionalEnvelopeString(32), sessionToken: optionalEnvelopeString(128),
  payload: CCBPayloadSchemas[type],
}, strict);
export const CCBMessageSchemas = Object.fromEntries(
  (Object.keys(CCBPayloadSchemas) as CCBCommand[]).map((type) => [type, createCCBMessageSchema(type)]),
) as { [K in CCBCommand]: ReturnType<typeof createCCBMessageSchema<K>> };
export const CCBClientMessageSchema = t.Union(Object.values(CCBMessageSchemas));
export type CCBClientWireMessage = Static<typeof CCBClientMessageSchema>;
export function normalizeCCBEnvelope(input: CCBClientWireMessage): CCBClientMessage {
  const message = { ...input };
  for (const key of ["traceId", "roomId", "sessionToken"] as const) {
    if (message[key] === null) delete message[key];
  }
  // 唯一差异是上面已消除的 nullable 信封；payload 的 K→Schema 关联由映射维持。
  return message as CCBClientMessage;
}
