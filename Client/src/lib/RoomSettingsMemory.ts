import type {
  AnimeAutoFilters,
  CCBSettings,
  RoleConfig,
  SongAutoFilters,
  SongQuestionMode,
  SongQuestionType,
} from "@/types";

/**
 * 三个游戏的「上次房间设置」记忆：创建成功的弹窗选项存下来供下次弹窗沿用，
 * 房间内的玩法设置另外存一份，由等待页在新建房间时重放。
 * 按产品决定不落盘名称与密码（用户明确）；所有读写都容错——存储被禁用或数据损坏时按「没有记忆」处理。
 */
export type RoomGame = "faker" | "song" | "ccb";

/** 创建弹窗里可沿用的选项；`source` 是猜猜呗的服务器来源（兼容原版）。 */
export interface RoomCreateDefaults {
  visibility: "public" | "private";
  allowSpectators: boolean;
  source?: "native" | "original";
}

/** 谁是卧底的房间内设置：揭露规则与阵营配置。 */
export interface FakerRoomSettingsMemory {
  revealRoleOnDeath: boolean;
  roleConfig: RoleConfig;
}

/** 猜歌/猜番的题目设置：与题目面板保存的载荷同形，重放时原样发回。 */
export interface SongRoomQuestionMemory {
  questionType: SongQuestionType;
  questionMode: SongQuestionMode;
  autoRotateSubmitter: boolean;
  autoFilters: SongAutoFilters;
  animeAutoFilters: AnimeAutoFilters;
}

/** 猜歌/猜番的猜测设置：与猜测面板保存的载荷同形。 */
export interface SongRoomGameMemory {
  lyricsLineCount: number;
  showLyrics: boolean;
  maxGuessesPerRound: number;
  guessDurationSeconds: number;
  showGuessTimer: boolean;
  bloodMode: boolean;
}

/** 题、猜两组分开记：两个面板各存各的，互不覆盖。 */
export interface SongRoomSettingsMemory {
  question?: SongRoomQuestionMemory;
  game?: SongRoomGameMemory;
}

/** 猜猜呗的房间内设置：整个 `CCBSettings` 原样记录、原样重放。 */
export interface CCBRoomSettingsMemory {
  settings: CCBSettings;
}

/** 各游戏的设置记忆形状，读写函数按 `game` 分派类型。 */
export interface RoomSettingsMemoryByGame {
  faker: FakerRoomSettingsMemory;
  song: SongRoomSettingsMemory;
  ccb: CCBRoomSettingsMemory;
}

const CREATE_PREFIX = "bakagame:room-create:";
const SETTINGS_PREFIX = "bakagame:room-settings:";
const RESTORE_PREFIX = "bakagame:room-restore:";

const getLocalStorage = (): Storage | null => {
  try {
    if (typeof window === "undefined") return null;
    return window.localStorage;
  } catch {
    return null;
  }
};

const readJson = <T>(key: string): T | null => {
  try {
    const raw = getLocalStorage()?.getItem(key);
    return raw ? (JSON.parse(raw) as T) : null;
  } catch {
    return null;
  }
};

const writeJson = (key: string, value: unknown): void => {
  try {
    getLocalStorage()?.setItem(key, JSON.stringify(value));
  } catch {
    // 存储被禁用或写满时静默：记忆是增强，不影响建房主流程。
  }
};

/** 读取创建弹窗的默认选项；没有记忆或形状不对时返回 null。 */
export function readRoomCreateDefaults(game: RoomGame): RoomCreateDefaults | null {
  const value = readJson<Partial<RoomCreateDefaults>>(CREATE_PREFIX + game);
  if (!value) return null;
  if (value.visibility !== "public" && value.visibility !== "private") return null;
  if (typeof value.allowSpectators !== "boolean") return null;
  return {
    visibility: value.visibility,
    allowSpectators: value.allowSpectators,
    ...(value.source === "native" || value.source === "original" ? { source: value.source } : {}),
  };
}

/** 记录本次创建用的选项（创建成功后调用）。 */
export function saveRoomCreateDefaults(game: RoomGame, defaults: RoomCreateDefaults): void {
  writeJson(CREATE_PREFIX + game, {
    visibility: defaults.visibility,
    allowSpectators: defaults.allowSpectators,
    ...(defaults.source ? { source: defaults.source } : {}),
  });
}

/** 读取房间内设置记忆；没有或损坏时返回 null，由调用方按「无记忆」跳过恢复。 */
export function readRoomSettingsMemory<G extends RoomGame>(game: G): RoomSettingsMemoryByGame[G] | null {
  const value = readJson<unknown>(SETTINGS_PREFIX + game);
  return value && typeof value === "object" ? (value as RoomSettingsMemoryByGame[G]) : null;
}

/** 覆盖写入房间内设置记忆。 */
export function saveRoomSettingsMemory<G extends RoomGame>(game: G, memory: RoomSettingsMemoryByGame[G]): void {
  writeJson(SETTINGS_PREFIX + game, memory);
}

/** 读取-合并-写回：同一游戏有多个面板各存各的部分时用（如猜歌的题、猜两组）。 */
export function updateRoomSettingsMemory<G extends RoomGame>(
  game: G,
  patch: (current: RoomSettingsMemoryByGame[G] | null) => RoomSettingsMemoryByGame[G],
): void {
  saveRoomSettingsMemory(game, patch(readRoomSettingsMemory(game)));
}

/** 登记「这个房间刚由本机创建」：进房后的等待页凭它套用上次设置。 */
export function markPendingRestore(game: RoomGame, roomId: string): void {
  try {
    getLocalStorage()?.setItem(RESTORE_PREFIX + game, roomId);
  } catch {
    // 忽略浏览器禁用存储的情况。
  }
}

/** 读取待恢复的房间号；没有时返回 null。 */
export function peekPendingRestore(game: RoomGame): string | null {
  try {
    return getLocalStorage()?.getItem(RESTORE_PREFIX + game) ?? null;
  } catch {
    return null;
  }
}

/**
 * 原子取走待恢复标记：只有与当前房间匹配时才清掉它，并返回房间内设置记忆（可能为空）。
 * 不匹配（标记属于别的房间、或已被消费）时不动存储并返回 null。
 */
export function takePendingRestoreMemory<G extends RoomGame>(
  game: G,
  roomId: string,
): RoomSettingsMemoryByGame[G] | null {
  try {
    const storage = getLocalStorage();
    if (!storage || storage.getItem(RESTORE_PREFIX + game) !== roomId) return null;
    storage.removeItem(RESTORE_PREFIX + game);
    return readRoomSettingsMemory(game);
  } catch {
    return null;
  }
}
