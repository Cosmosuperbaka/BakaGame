import { schemaUnion } from "./SchemaUnion";
import { Type as t, type Static } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
import type { ChatMessage, PlayerAccount, RoomVisibility } from "./Model";
import type { ClientEnvelope } from "./Protocol";

const strict = { additionalProperties: false } as const;
const integer = (minimum: number, maximum: number) => t.Integer({ minimum, maximum });
export const CEESettingsSchema = t.Object(
  {
    startYear: integer(1900, 2200),
    endYear: integer(1900, 2200),
    topNSubjects: integer(1, 1000),
    useSubjectPerYear: t.Boolean(),
    metaTags: t.Array(t.String({ maxLength: 40 }), { maxItems: 3 }),
    useIndex: t.Boolean(),
    indexId: t.Union([integer(1, 2147483647), t.Null()]),
    addedSubjects: t.Array(integer(1, 2147483647), { maxItems: 500 }),
    mainCharacterOnly: t.Boolean(),
    characterNum: integer(1, 100),
    maxAttempts: integer(1, 100),
    timeLimit: integer(0, 120),
    subjectSearch: t.Boolean(),
    subjectTagNum: integer(0, 10),
    characterTagNum: integer(0, 10),
    useHints: t.Array(integer(0, 100), { maxItems: 3 }),
    useImageHint: integer(0, 100),
    globalPick: t.Boolean(),
    tagBan: t.Boolean(),
    syncMode: t.Boolean(),
    nonstopMode: t.Boolean(),
    /** 出题方式：`random` 开始即随机抽题；`manual` 开始后进入选出题人阶段，由房主指定出题人。 */
    answerMode: t.Union([t.Literal("random"), t.Literal("manual")]),
    /**
     * 反作弊房开关。它晚于设置格式加入，而 schema 是 strict：写成必填会让旧客户端发来的
     * 设置整包被判非法，所以只能 optional。缺省即关闭，不开关的房间与以往完全一致。
     */
    bakaAntiCheat: t.Optional(t.Boolean()),
    /** 是否允许 Agent（MCP）加入；缺省 false，旧客户端不传即为关闭。 */
    allowAgents: t.Optional(t.Boolean()),
  },
  strict
);
export type CEESettings = Static<typeof CEESettingsSchema>;
export type CEEAnswerMode = CEESettings["answerMode"];
/** 房间是否按反作弊口径收口：只有显式 `true` 才算开启，缺省与 `false` 同义。 */
export const isCEEAntiCheatRoom = (settings: Pick<CEESettings, "bakaAntiCheat">): boolean =>
  settings.bakaAntiCheat === true;
/**
 * 导入设置文件。出题方式与反作弊开关都晚于文件格式加入，旧文件缺这些项时分别按随机出题、
 * 关闭补齐；「显示常见标签」已固定开启，旧文件里的 `commonTags` 直接丢弃。
 */
export function parseCEESettings(value: unknown): CEESettings {
  let filled = value;
  if (value && typeof value === "object" && !Array.isArray(value)) {
    const { commonTags: _commonTags, ...rest } = value as Record<string, unknown>;
    const normalized: Record<string, unknown> = { ...rest };
    if (!("answerMode" in normalized)) normalized.answerMode = "random";
    if (!("bakaAntiCheat" in normalized)) normalized.bakaAntiCheat = false;
    if (!("allowAgents" in normalized)) normalized.allowAgents = false;
    filled = normalized;
  }
  if (!Value.Check(CEESettingsSchema, filled)) throw new Error("设置文件格式不正确");
  return filled;
}
export const createDefaultCEESettings = (year = new Date().getFullYear()): CEESettings => ({
  startYear: year - 5,
  endYear: year,
  topNSubjects: 20,
  useSubjectPerYear: false,
  metaTags: ["", "", ""],
  useIndex: false,
  indexId: null,
  addedSubjects: [],
  mainCharacterOnly: true,
  characterNum: 6,
  maxAttempts: 10,
  timeLimit: 60,
  subjectSearch: true,
  subjectTagNum: 4,
  characterTagNum: 4,
  useHints: [],
  useImageHint: 0,
  globalPick: false,
  tagBan: false,
  syncMode: false,
  nonstopMode: false,
  answerMode: "random",
  bakaAntiCheat: false,
  allowAgents: false,
});
export type CEESource = "native" | "original";
/**
 * 角色/作品图的取用尺寸，只有两档，`small` / `medium` / `common` 一律不取：
 *
 * - `grid`：方格图，用于搜索列表这类 36~40px **方形**缩略图——竖版大图在方框里
 *   会被裁到只剩头顶，方格图比例正对方框且体积小一个量级；
 * - `large`：大图，用于**长条**场景——竖版作品封面、图片提示与答案卡。
 *
 * `common` 比 `medium` 还低一档且只有作品才有，不参与任何回退。**作品的 `grid`
 * 是 `large` 直接裁出来的，存它没有意义**，所以只有角色落 `grid`。
 * 服务端一次回源把该实体需要的尺寸存下来，之后按用途各取所需。
 */
export type CEEImageSize = "grid" | "large";
/** `choosingSetter`：手动出题时房主开始后、指定出题人之前的独立阶段。 */
export type CEEPhase =
  "waiting" | "choosingSetter" | "preparing" | "answering" | "guessing" | "settled";
export interface CEECharacterSummary {
  id: number;
  name: string;
  nameCn: string;
  imageUrl?: string;
}
export interface CEEAppearance {
  id: number;
  name: string;
  nameCn: string;
  year: number;
  rating: number;
  ratingCount: number;
}
export type CEEComparisonAppearance = Pick<CEEAppearance, "id" | "name" | "nameCn">;
export interface CEEExtraTagSection {
  section: string;
  tags: string[];
}
export interface CEECharacterView extends CEECharacterSummary {
  gender: "male" | "female" | "?";
  popularity: number;
  summary: string;
  appearances: CEEAppearance[];
  highestRating: number;
  earliestAppearance: number;
  latestAppearance: number;
  subjectTags: string[];
  characterTags: string[];
  voiceActors: string[];
  metaTags: string[];
  comparisonAppearances: CEEComparisonAppearance[];
  extraTags: CEEExtraTagSection[];
}
export interface CEESubjectSummary {
  id: number;
  name: string;
  nameCn: string;
  type: number;
  year: number | null;
  rating: number;
  heat: number;
  imageUrl?: string;
}
export interface CEEDirectoryResult {
  id: number;
  subjectIds: number[];
  missingSubjectIds: number[];
  importedAt: number;
}
export type CEEComparison = "=" | "+" | "++" | "-" | "--" | "?" | "yes" | "no";
export interface CEEFeedbackValue {
  value: number | string;
  comparison: CEEComparison;
}
export interface CEEFeedback {
  gender: CEEFeedbackValue;
  popularity: CEEFeedbackValue;
  rating: CEEFeedbackValue;
  appearancesCount: CEEFeedbackValue;
  earliestAppearance: CEEFeedbackValue;
  latestAppearance: CEEFeedbackValue;
  sharedAppearances: CEEComparisonAppearance[];
  tags: Array<{
    text: string;
    matched: boolean;
    hidden: boolean;
    kind: "subject" | "character" | "voice";
  }>;
  extraTags: Array<{ section: string; tags: Array<{ text: string; matched: boolean }> }>;
}
export interface CEEGuess {
  id: string;
  playerId: string;
  playerName: string;
  character: CEECharacterSummary;
  correct: boolean;
  partial: boolean;
  syncRound: number;
  createdAt: number;
  feedback: CEEFeedback;
}
export type CEEPlayerStatus =
  "waiting" | "playing" | "solved" | "teamWon" | "exhausted" | "surrendered" | "observing";
export interface CEEPlayer {
  id: string;
  name: string;
  online: boolean;
  ready: boolean;
  team: number | null;
  /**
   * `pendingSpectator` 只出现在反作弊房：旁观要房主批准，待批准期间按「尚未入房」对待，
   * 不下发私有状态，否则请求者能提前看到房间内部信息。
   */
  membership: "active" | "spectator" | "pendingSpectator";
  score: number;
  status: CEEPlayerStatus;
  attempts: number;
  marks: string;
  syncCompleted: boolean;
  /** 通过 MCP 接入的 Agent 玩家；界面与准入据此识别。 */
  isAgent?: boolean;
  account?: PlayerAccount;
}
export interface CEEScoreDetail {
  playerId: string;
  playerName: string;
  score: number;
  base: number;
  firstGuess: number;
  quickGuess: number;
  partial: number;
  setter: number;
  reason: string;
  rank?: number;
}
export interface CEERoundSummary {
  answer: CEECharacterView;
  scores: CEEScoreDetail[];
  guesses: CEEGuess[];
  winners: Array<{ playerId: string; rank: number; score: number }>;
}
export interface CEESpectateRequest {
  playerId: string;
  name: string;
  requestedAt: number;
}
export interface CEERoomSnapshot {
  roomId: string;
  source: CEESource;
  name: string;
  visibility: RoomVisibility;
  hasPassword: boolean;
  allowSpectators: boolean;
  /** 反作弊房标记：快照里恒有，客户端据此解释旁观待批准与登录门槛。 */
  bakaAntiCheat: boolean;
  hostPlayerId: string;
  phase: CEEPhase;
  settings: CEESettings;
  players: CEEPlayer[];
  roundNumber: number;
  syncRound: number;
  setterPlayerId: string | null;
  phaseDeadlineAt: number | null;
  chat: ChatMessage[];
  roundSummary: CEERoundSummary | null;
  upstreamConnected: boolean;
  /** 待房主批准的旁观请求，按发起时间升序；非反作弊房恒为空数组。 */
  spectateRequests: CEESpectateRequest[];
}
export interface CEEPrivateState {
  playerId: string;
  canGuess: boolean;
  canSurrender: boolean;
  canStart: boolean;
  canSetAnswer: boolean;
  setterCandidateIds: string[];
  guesses: CEEGuess[];
  answer: CEECharacterView | null;
  hints: string[];
  imageHintAvailable: boolean;
  imageHintLevel: number;
  deadlineAt: number | null;
  bannedCharacterIds: number[];
  /** 反作弊房里本人正在等房主批准旁观；待批准期间本字段之外的私有信息一律为空。 */
  spectatePending: boolean;
}
/**
 * 大厅房间条目。`roomId` 是统一的 4 位房号（原版客户端建的 UUID 房为服务端分配的别名）。
 * `playerCount` 只计参与玩家；原版列表不提供旁观人数，`spectatorCount` 为 `null`，界面不得显示为 0。
 */
export interface CEERoomSummary {
  roomId: string;
  source: CEESource;
  name: string;
  phase: CEEPhase;
  playerCount: number;
  spectatorCount: number | null;
  hasPassword: boolean;
  allowSpectators: boolean;
  /** 大厅条目也要带上：玩家必须在**进房前**看到这房需要客户端，而不是点进去才被拒。 */
  bakaAntiCheat: boolean;
}
export interface CEERoomEnterResult {
  roomId: string;
  source: CEESource;
  sessionToken: string;
  snapshot: CEERoomSnapshot;
  privateState: CEEPrivateState;
}
const empty = t.Object({}, strict);
const source = t.Union([t.Literal("native"), t.Literal("original")]);
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
const imageSize = t.Union([t.Literal("grid"), t.Literal("large")]);
export const CEEPayloadSchemas = {
  "cee.lobby.subscribeRooms": empty,
  "cee.room.create": t.Object(
    {
      source,
      roomId,
      name,
      userName: name,
      visibility: t.Union([t.Literal("public"), t.Literal("private")]),
      password: optionalPassword,
      allowSpectators: t.Boolean(),
      /**
       * 反作弊只在**建房这一刻**决定，进房后的设置载荷改不动它（`CEERooms` 一律沿用房里的现值）。
       * 中途开关会让同一间房里的人按不同口径准入，旁观审批、断线重连的规则都会错位。
       * optional 的理由与设置里那条一样：旧客户端不发这个字段，缺省即普通房。
       */
      bakaAntiCheat: t.Optional(t.Boolean()),
      allowAgents: t.Optional(t.Boolean()),
    },
    strict
  ),
  // 进入已有房间只凭统一房号，来源由服务端的房号目录判定；只有建房需要声明建在哪个服务器。
  "cee.room.join": t.Object({ userName: name, password: optionalPassword }, strict),
  "cee.room.reconnect": t.Object({ roomId, sessionToken: recoverySessionToken }, strict),
  "cee.room.leave": empty,
  "cee.room.requestSync": empty,
  // 切到私密时 `password` 给新密码；留空或缺席表示沿用已有密码。转为公开会清除密码。
  "cee.room.update": t.Object(
    {
      name,
      visibility: t.Union([t.Literal("public"), t.Literal("private")]),
      allowSpectators: t.Boolean(),
      password: optionalPassword,
    },
    strict
  ),
  "cee.room.settings": t.Object({ settings: CEESettingsSchema }, strict),
  "cee.player.ready": t.Object({ ready: t.Boolean() }, strict),
  "cee.player.team": t.Object({ team: t.Union([integer(1, 8), t.Null()]) }, strict),
  "cee.player.spectate": t.Object({ spectator: t.Boolean() }, strict),
  /** 反作弊房里房主处理旁观请求；`approved` 为假即明确拒绝，不再让请求悬到超时。 */
  "cee.player.approveSpectate": t.Object({ playerId, approved: t.Boolean() }, strict),
  "cee.room.kick": t.Object({ playerId }, strict),
  "cee.room.transferHost": t.Object({ playerId }, strict),
  "cee.chat.send": t.Object({ text: t.String({ minLength: 1, maxLength: 500 }) }, strict),
  "cee.character.search": t.Object({ keyword: t.String({ minLength: 1, maxLength: 80 }) }, strict),
  "cee.subject.search": t.Object({ keyword: t.String({ minLength: 1, maxLength: 80 }) }, strict),
  "cee.subject.characters": t.Object({ subjectId: id }, strict),
  /** 按编号取作品名，供设置里的追加作品显示名称；上限与 `addedSubjects` 一致。 */
  "cee.subject.lookup": t.Object({ subjectIds: t.Array(id, { maxItems: 500 }) }, strict),
  "cee.directory.import": t.Object({ indexId: id }, strict),
  /**
   * 搜索列表滚进视口时的补图。列表是方形缩略图，默认取 `grid`；
   * 图片提示与答案卡走服务端内部调用，固定 `medium`，不走这条命令。
   */
  "cee.character.image": t.Object({ characterId: id, size: t.Optional(imageSize) }, strict),
  "cee.subject.image": t.Object({ subjectId: id }, strict),
  "cee.game.start": empty,
  "cee.game.chooseSetter": t.Object({ playerId }, strict),
  "cee.game.setAnswer": t.Object(
    { characterId: id, hints: t.Array(t.String({ maxLength: 30 }), { maxItems: 3 }) },
    strict
  ),
  "cee.game.cancel": empty,
  "cee.game.guess": t.Object({ characterId: id }, strict),
  "cee.game.surrender": empty,
  "cee.game.next": empty,
  "cee.game.imageHint": empty,
} as const;
export type CEECommand = keyof typeof CEEPayloadSchemas;
export type CEEPayload<T extends CEECommand> = Static<(typeof CEEPayloadSchemas)[T]>;
export type CEEClientMessage = { [K in CEECommand]: ClientEnvelope<K, CEEPayload<K>> }[CEECommand];
export const CEE_STATE_EVENTS = ["cee.room.snapshot", "cee.game.privateState"] as const;
/** 大厅房间列表的事件名；口径同另外两个游戏，服务端与传输层丢弃判定读同一个常量。 */
export const CEE_LOBBY_ROOMS_EVENT = "cee.lobby.rooms";

/** 线路信封接纳 null；进入业务层前统一规范化为可选字符串。 */
const optionalEnvelopeString = (maxLength: number) =>
  t.Optional(t.Union([t.String({ maxLength }), t.Null()]));
const createCEEMessageSchema = <K extends CEECommand>(type: K) =>
  t.Object(
    {
      id: t.String({ minLength: 1, maxLength: 128 }),
      traceId: optionalEnvelopeString(128),
      type: t.Literal(type),
      roomId: optionalEnvelopeString(32),
      sessionToken: optionalEnvelopeString(128),
      payload: CEEPayloadSchemas[type],
    },
    strict
  );
export const CEEMessageSchemas = Object.fromEntries(
  (Object.keys(CEEPayloadSchemas) as CEECommand[]).map((type) => [
    type,
    createCEEMessageSchema(type),
  ])
) as { [K in CEECommand]: ReturnType<typeof createCEEMessageSchema<K>> };
export const CEEClientMessageSchema = schemaUnion(Object.values(CEEMessageSchemas));
export type CEEClientWireMessage = Static<typeof CEEClientMessageSchema>;
/**
 * 命令 → ack 载荷。原先写在 `Client/src/lib/CEEWs.ts`，是「同一事实第三份拷贝」的一员：
 * 客户端手写一条条件类型链，服务端改 handler 返回值时这里不会跟着变。挪到命令表旁边，
 * 两端引用同一条推导。
 */
export type CEEResponse<TCommand extends CEECommand> = TCommand extends "cee.lobby.subscribeRooms"
  ? { originalAvailable: boolean }
  : TCommand extends "cee.room.create" | "cee.room.join" | "cee.room.reconnect"
    ? CEERoomEnterResult
    : TCommand extends "cee.character.search" | "cee.subject.characters"
      ? { results: CEECharacterSummary[] }
      : TCommand extends "cee.subject.search" | "cee.subject.lookup"
        ? { results: CEESubjectSummary[] }
        : TCommand extends "cee.directory.import"
          ? CEEDirectoryResult
          : TCommand extends "cee.character.image" | "cee.subject.image"
            ? { imageUrl?: string }
            : TCommand extends "cee.game.imageHint"
              ? { dataUrl: string }
              : Record<string, unknown>;

export function normalizeCEEEnvelope(input: CEEClientWireMessage): CEEClientMessage {
  const message = { ...input };
  for (const key of ["traceId", "roomId", "sessionToken"] as const) {
    if (message[key] === null) delete message[key];
  }
  // 唯一差异是上面已消除的 nullable 信封；payload 的 K→Schema 关联由映射维持。
  return message as CEEClientMessage;
}
