import type { GameId } from "../GameClient";
import type { UiControl, UiPart, UiScreen, UiSection } from "./Types";
import { isRecord } from "../../shared/Json";
import { GAME_COMMAND_TIMEOUT_MS } from "../Timeouts";

export { isRecord };

export interface UiSearchState {
  /** 搜索栏控件前缀，例如 song.submit.search。 */
  prefix: string;
  purpose: "song_submit" | "song_guess" | "cee_answer" | "cee_guess";
  kind: "song" | "anime" | "character" | "subject";
  keyword: string;
  status: "idle" | "loading" | "ready" | "error";
  results: Array<Record<string, unknown>>;
  error?: string;
  /** 猜番出题：已点开的番剧与它的关联曲。 */
  subject?: Record<string, unknown>;
}

export interface UiState {
  roomId?: string;
  phase?: string;
  focus?: string;
  drafts: Record<string, string>;
  search?: UiSearchState;
  songPreview?: Record<string, unknown>;
  songClip?: { startTime: number; endTime: number };
  ceeAnswer?: Record<string, unknown>;
  ceeHints: [string, string, string];
  ceeCast?: { subject: Record<string, unknown>; characters: Array<Record<string, unknown>> };
  ceeImage?: { level: number; dataUrl: string };
  lastFeedback?: string;
  /** 已就当前回合上报过音频就绪，避免每次读屏都重复发命令。 */
  audioReadyRound?: number;
}

export const createUiState = (): UiState => ({
  drafts: {},
  ceeHints: ["", "", ""],
});

/** 换阶段时清掉本地临时界面状态；聊天草稿跨阶段保留，和玩家页面一致。 */
export const syncPhase = (state: UiState, phase: string): void => {
  if (state.phase === phase) return;
  const chatDraft = state.drafts["chat.input"];
  state.phase = phase;
  state.focus = undefined;
  state.drafts = chatDraft === undefined ? {} : { "chat.input": chatDraft };
  state.search = undefined;
  state.songPreview = undefined;
  state.songClip = undefined;
  state.ceeAnswer = undefined;
  state.ceeHints = ["", "", ""];
  state.ceeCast = undefined;
  state.ceeImage = undefined;
};

export interface UiContext {
  game: GameId;
  client: {
    sendInRoom(
      game: GameId,
      type: string,
      payload?: Record<string, unknown>,
      options?: { timeoutMs?: number }
    ): Promise<unknown>;
    currentPlayerId(game: GameId): string | undefined;
  };
  playerId?: string;
  snapshot: Record<string, unknown>;
  privateState: Record<string, unknown>;
  state: UiState;
  now: number;
}

export const str = (value: unknown): string | undefined =>
  typeof value === "string" ? value : undefined;

export const list = (value: unknown): unknown[] => (Array.isArray(value) ? value : []);

export const recordList = (value: unknown): Array<Record<string, unknown>> =>
  list(value).filter(isRecord);

export const control = (
  id: string,
  label: string,
  role: UiControl["role"],
  part: UiPart,
  extra: Partial<UiControl> = {}
): UiControl => ({ id, label, role, part, ...extra });

export const button = (
  id: string,
  label: string,
  part: UiPart = "game",
  extra: Partial<UiControl> = {}
): UiControl => control(id, label, "button", part, extra);

export const textbox = (
  id: string,
  label: string,
  value: string,
  part: UiPart = "game",
  extra: Partial<UiControl> = {}
): UiControl => control(id, label, "textbox", part, { value, ...extra });

export const section = (id: string, title: string, controls: UiControl[]) => ({
  id,
  title,
  controls,
});

export const chatControls = (state: UiState): UiControl[] => [
  textbox("chat.input", "聊天消息", state.drafts["chat.input"] ?? "", "chat", {
    hint: "输入后按 Enter 或点击发送",
  }),
  button("chat.send", "发送消息", "chat", {
    disabled: !(state.drafts["chat.input"] ?? "").trim(),
  }),
];

export const projectChat = (snapshot: Record<string, unknown>) =>
  recordList(snapshot.chat)
    .slice(-50)
    .map((message) => ({
      id: message.id,
      playerId: message.playerId,
      playerName: message.playerName,
      text: message.text,
      createdAt: message.createdAt,
      system: message.system === true,
      ...(typeof message.channel === "string" ? { channel: message.channel } : {}),
      ...(typeof message.ghostRole === "string" ? { ghostRole: message.ghostRole } : {}),
    }));

export const playerName = (snapshot: Record<string, unknown>, id: unknown): string => {
  const found = recordList(snapshot.players).find((player) => player.id === id);
  return str(found?.name) ?? "该玩家";
};

/** 某款游戏的命令发送：房间内命令，超时取自按游戏声明的超时表。 */
export const gameSender =
  (game: GameId) =>
  (context: UiContext, type: string, payload: Record<string, unknown> = {}) =>
    context.client.sendInRoom(game, type, payload, { timeoutMs: GAME_COMMAND_TIMEOUT_MS[game] });

/** 当前座位的玩家编号：命令上下文里带的优先，退回私有状态。 */
export const seatIdOf = (context: UiContext): unknown =>
  context.playerId ?? context.privateState.playerId;

/** 玩家栏里属于本座位的那一条。 */
export const selfOf = (context: UiContext) =>
  recordList(context.snapshot.players).find((player) => player.id === seatIdOf(context));

/** 本座位是不是房主：以快照里的房主编号为准。 */
export const isHostOf = (context: UiContext): boolean =>
  context.snapshot.hostPlayerId === seatIdOf(context);

export const settingsOf = (context: UiContext): Record<string, unknown> =>
  isRecord(context.snapshot.settings) ? context.snapshot.settings : {};

/** 玩家栏条目里的账号头像；没有账号头像时不带这个字段。 */
export const avatarOf = (player: Record<string, unknown>): { avatar?: string } =>
  isRecord(player.account) && typeof player.account.image === "string"
    ? { avatar: player.account.image }
    : {};

/** 队伍下拉：不组队加 1–8 队，三款有队伍的玩法口径一致。 */
export const teamSelect = (id: string, me: Record<string, unknown>, hint: string): UiControl =>
  control(id, "队伍", "select", "game", {
    value: typeof me.team === "number" ? String(me.team) : "none",
    options: [
      { value: "none", label: "不组队" },
      ...Array.from({ length: 8 }, (_, index) => ({
        value: String(index + 1),
        label: `${index + 1} 队`,
      })),
    ],
    hint,
  });

/** 设置队伍的取值：1–8 或「none」不组队；其余一律拒绝。返回要发给服务端的队伍号。 */
export const teamOf = (value: unknown): number | null => {
  if (value !== "none" && !/^[1-8]$/.test(String(value)))
    throw new Error("队伍必须是 1–8 或不组队");
  return value === "none" ? null : Number(value);
};

export const teamFeedback = (value: unknown): string =>
  value === "none" ? "已退出队伍" : `已加入 ${String(value)} 队`;

/** 每个游戏屏幕都由「可操作控件」与「聊天」两段组成。 */
export const screenSections = (
  game: string,
  actions: UiControl[],
  context: UiContext
): UiSection[] => [
  section(`${game}.actions`, "可操作控件", actions),
  section(`${game}.chat`, "聊天", chatControls(context.state)),
];

/** 屏幕 `you` 字段里三款共有的开头四项；顺序是对外契约的一部分。 */
export const youBase = (context: UiContext, isHost: boolean) => {
  const me = selfOf(context);
  return {
    playerId: seatIdOf(context),
    name: me?.name,
    isHost,
    membership: me?.membership,
  };
};

// ---------------------------------------------------------------- 搜索流程（猜歌与猜角色共用）

/** 人类页面停止输入后才自动查询；Agent 保持同样的节拍。 */
export const SEARCH_DEBOUNCE_MS = 420;

export const waitSearchDebounce = (): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, SEARCH_DEBOUNCE_MS));

/** 控件 id 形如 `<前缀>.input`；不是输入框时返回空串。 */
export const inputPrefixOf = (controlId: string): string =>
  controlId.endsWith(".input") ? controlId.slice(0, -".input".length) : "";

/** 上游应答里的结果表；应答不是对象时按空表处理。 */
export const ackResults = (ack: unknown): Array<Record<string, unknown>> =>
  isRecord(ack) ? recordList(ack.results) : [];

/** 取当前搜索态：前缀对不上说明结果已经被别的操作换掉了。 */
export const requireSearch = (
  context: UiContext,
  prefix: string,
  changedMessage: string,
  options: { nonEmpty?: boolean } = {}
): UiSearchState => {
  const search = context.state.search;
  if (!search || search.prefix !== prefix) throw new Error(changedMessage);
  if (options.nonEmpty && (search.status !== "ready" || search.results.length === 0))
    throw new Error("当前没有可选结果");
  return search;
};

export const searchResultAt = (search: UiSearchState, index: string): Record<string, unknown> => {
  const value = Number.parseInt(index, 10);
  const result = Number.isInteger(value) ? search.results[value] : undefined;
  if (!result) throw new Error(`结果 ${index} 不存在`);
  return result;
};

/**
 * 执行一次检索并把结果或失败记进搜索态。失败时先记下再重新抛出：
 * 是否把失败交给调用方（按键触发）还是只留在状态里（自动检索）由调用方决定。
 */
export const loadSearch = async (
  search: UiSearchState,
  query: () => Promise<unknown>
): Promise<void> => {
  try {
    search.results = ackResults(await query());
    search.status = "ready";
  } catch (error) {
    search.status = "error";
    search.error = error instanceof Error ? error.message : String(error);
    throw error;
  }
};

/** 点开一个作品（番剧）后切到它的关联结果表。 */
export const openSubjectResults = (
  search: UiSearchState,
  subject: Record<string, unknown>,
  ack: unknown
): void => {
  search.subject = subject;
  search.results = ackResults(ack);
  search.status = "ready";
};

/** 把页面标题、提示、玩家栏、聊天栏统一挂到每个游戏屏幕上。 */
export const assemble = (
  context: UiContext,
  screen: Omit<
    UiScreen,
    "game" | "roomId" | "roomName" | "playerId" | "players" | "chat" | "updatedAt" | "controls"
  >,
  players: Array<Record<string, unknown>>
): UiScreen => {
  const controls = screen.sections.flatMap((entry) => entry.controls);
  return {
    ...screen,
    game: context.game,
    roomId: str(context.snapshot.roomId),
    roomName: str(context.snapshot.name),
    playerId: context.playerId ?? str(context.privateState.playerId),
    players,
    chat: projectChat(context.snapshot),
    controls,
    ...(context.state.lastFeedback ? { feedback: context.state.lastFeedback } : {}),
    updatedAt: context.now,
  };
};

/** 聊天模块共用的发送逻辑；三个游戏仅命令名不同，由各自模块调用。 */
export async function sendChat(context: UiContext, command: string): Promise<string> {
  const value = (context.state.drafts["chat.input"] ?? "").trim();
  if (!value) throw new Error("聊天内容不能为空");
  await context.client.sendInRoom(context.game, command, { text: value });
  delete context.state.drafts["chat.input"];
  return "聊天消息已发送";
}
