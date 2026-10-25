import type { GameId } from "../GameClient";
import type { UiControl, UiPart, UiScreen } from "./Types";
import { isRecord } from "../../shared/Json";

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

export const num = (value: unknown): number | undefined =>
  typeof value === "number" && Number.isFinite(value) ? value : undefined;

export const bool = (value: unknown): boolean => value === true;

export const list = (value: unknown): unknown[] => (Array.isArray(value) ? value : []);

export const recordList = (value: unknown): Array<Record<string, unknown>> =>
  list(value).filter(isRecord);

export const text = (value: unknown, max = 200): string =>
  typeof value === "string" ? value.slice(0, max) : "";

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

export const playerExists = (snapshot: Record<string, unknown>, id: string): boolean =>
  recordList(snapshot.players).some((player) => player.id === id);

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

export const describeCommandResult = (value: unknown, fallback: string): string => {
  if (!isRecord(value)) return fallback;
  if (typeof value.message === "string") return value.message;
  if (typeof value.sent === "boolean" && value.sent) return fallback;
  return fallback;
};
