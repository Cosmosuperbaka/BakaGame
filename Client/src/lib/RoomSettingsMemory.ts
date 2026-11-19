import type { GameId } from "@bakagame/shared";
import { notifyPreferencesChanged } from "@/lib/PreferenceBus";
import { localStore } from "@/lib/SafeStorage";
import type {
  AnimeAutoFilters,
  CEESettings,
  RoleConfig,
  SongAutoFilters,
  SongQuestionMode,
  SongQuestionType,
} from "@bakagame/shared";

/**
 * 三个游戏的「上次房间设置」记忆：创建成功的弹窗选项存下来供下次弹窗沿用，
 * 房间内的玩法设置另外存一份，由等待页在新建房间时重放。
 * 按产品决定不落盘名称与密码（用户明确）；所有读写都容错——存储被禁用或数据损坏时按「没有记忆」处理。
 */
export type RoomGame = GameId;

/** 创建弹窗里可沿用的选项；`source` 是猜猜呗的服务器来源（兼容原版）。 */
export interface RoomCreateDefaults {
  visibility: "public" | "private";
  allowSpectators: boolean;
  source?: "native" | "original";
}

/** 谁是卧底的房间内设置：揭露规则、旁观答案可见性与阵营配置。 */
export interface FakerRoomSettingsMemory {
  revealRoleOnDeath: boolean;
  spectatorsSeeAnswers: boolean;
  roleConfig: RoleConfig;
}

/** 猜歌/猜番的题目设置：与题目面板保存的载荷同形，重放时原样发回。 */
export interface SongRoomQuestionMemory {
  questionType: SongQuestionType;
  questionMode: SongQuestionMode;
  autoRotateSubmitter: boolean;
  /** 旧记录没有这一项：缺席时按服务端缺省重放。 */
  allowCustomClip?: boolean;
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

/** 猜歌/猜番的房间设置：旁观者局中能否看到答案，与卧底、猜猜呗同名同义。 */
export interface SongRoomRoomMemory {
  spectatorsSeeAnswers: boolean;
}

/** 题、猜、房间三组分开记：三个面板各存各的，互不覆盖。 */
export interface SongRoomSettingsMemory {
  question?: SongRoomQuestionMemory;
  game?: SongRoomGameMemory;
  room?: SongRoomRoomMemory;
}

/** 猜猜呗的房间内设置：整个 `CEESettings` 原样记录、原样重放。 */
export interface CEERoomSettingsMemory {
  settings: CEESettings;
}

/** 各游戏的设置记忆形状，读写函数按 `game` 分派类型。 */
export interface RoomSettingsMemoryByGame {
  faker: FakerRoomSettingsMemory;
  song: SongRoomSettingsMemory;
  cee: CEERoomSettingsMemory;
}

const CREATE_PREFIX = "bakagame:room-create:";
const SETTINGS_PREFIX = "bakagame:room-settings:";
const RESTORE_PREFIX = "bakagame:room-restore:";

/** 跟随账号云同步的记忆键前缀；待恢复标记只属于本机这一次建房，不同步。 */
export const ROOM_MEMORY_SYNC_PREFIXES = [CREATE_PREFIX, SETTINGS_PREFIX] as const;

const readJson = <T>(key: string): T | null => {
  try {
    const raw = localStore.get(key);
    return raw ? (JSON.parse(raw) as T) : null;
  } catch {
    return null;
  }
};

/** 存储被禁用或写满时静默：记忆是增强，不影响建房主流程。 */
const writeJson = (key: string, value: unknown): void => {
  if (localStore.set(key, JSON.stringify(value))) notifyPreferencesChanged();
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

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const SONG_QUESTION_KEYS = [
  "questionType",
  "questionMode",
  "autoRotateSubmitter",
  "allowCustomClip",
  "autoFilters",
  "animeAutoFilters",
] as const;
const SONG_QUESTION_REQUIRED = [
  "questionType",
  "questionMode",
  "autoRotateSubmitter",
  "autoFilters",
  "animeAutoFilters",
] as const;
const SONG_GAME_KEYS = [
  "lyricsLineCount",
  "showLyrics",
  "maxGuessesPerRound",
  "guessDurationSeconds",
  "showGuessTimer",
  "bloodMode",
] as const;

const SONG_ROOM_KEYS = ["spectatorsSeeAnswers"] as const;

type MemoryValidator = (value: unknown) => boolean;

/**
 * 各游戏记忆的形状校验，和重放给服务端的命令载荷用同一份共享 schema，不在这里另写一套。
 * schema 与校验库只在需要读记忆时才动态加载：它们体积不小，而客户端的运行时值入口
 * 不允许把它们带进首屏。
 */
const loadValidators = async (): Promise<Record<RoomGame, MemoryValidator>> => {
  const [{ Value }, shared] = await Promise.all([
    import("@sinclair/typebox/value"),
    import("@bakagame/shared"),
  ]);
  /** 一段记忆按载荷 schema 校验：键只能来自 `allowed`（口令等不该落盘的字段因此被拒），`required` 必须存在。 */
  const matchesPayload = (
    schema: Parameters<typeof Value.Check>[0],
    value: unknown,
    allowed: readonly string[],
    required: readonly string[]
  ): boolean =>
    isRecord(value) &&
    Object.keys(value).every((key) => allowed.includes(key)) &&
    required.every((key) => key in value) &&
    Value.Check(schema, value);
  const fakerUpdate = shared.WhoIsFakerPayloadSchemas["room.updateSettings"];
  const songUpdate = shared.SonGuessrPayloadSchemas["song.room.updateSettings"];
  return {
    faker: (value) =>
      matchesPayload(
        fakerUpdate,
        value,
        ["revealRoleOnDeath", "spectatorsSeeAnswers", "roleConfig"],
        ["revealRoleOnDeath", "roleConfig"]
      ),
    song: (value) =>
      isRecord(value) &&
      Object.keys(value).every((key) => key === "question" || key === "game" || key === "room") &&
      (value.question === undefined ||
        matchesPayload(songUpdate, value.question, SONG_QUESTION_KEYS, SONG_QUESTION_REQUIRED)) &&
      (value.game === undefined ||
        matchesPayload(songUpdate, value.game, SONG_GAME_KEYS, SONG_GAME_KEYS)) &&
      (value.room === undefined ||
        matchesPayload(songUpdate, value.room, SONG_ROOM_KEYS, SONG_ROOM_KEYS)),
    cee: (value) =>
      isRecord(value) &&
      Object.keys(value).length === 1 &&
      "settings" in value &&
      Value.Check(shared.CEESettingsSchema, value.settings),
  };
};

let validators: Promise<Record<RoomGame, MemoryValidator>> | null = null;

/** 是否存有该游戏的设置记忆（只看有没有，不校验形状）：用于决定要不要先渲染恢复占位。 */
export function hasRoomSettingsMemory(game: RoomGame): boolean {
  return Boolean(localStore.get(SETTINGS_PREFIX + game));
}

/** 校验一段原始记忆；不合规（含损坏）时删掉该键，返回 null。 */
const validateRawMemory = async <G extends RoomGame>(
  game: G,
  raw: string | null
): Promise<RoomSettingsMemoryByGame[G] | null> => {
  if (!raw) return null;
  try {
    const value: unknown = JSON.parse(raw);
    validators ??= loadValidators();
    if ((await validators)[game](value)) return value as RoomSettingsMemoryByGame[G];
  } catch {
    // 解析或加载校验器失败：与形状不合规一样按无记忆处理。
  }
  // 删之前复核：校验期间别处可能已写入了新的合规记忆，只删仍是这份原文的键。
  if (localStore.get(SETTINGS_PREFIX + game) === raw) localStore.remove(SETTINGS_PREFIX + game);
  return null;
};

/**
 * 读取房间内设置记忆：没有、JSON 损坏或形状不合规（旧版本或别的设备经云同步带来的数据）
 * 一律按「无记忆」处理并删掉该键，避免畸形数据被重放给服务端、或经合并写回再同步出去。
 * 这是偏好类本地记忆的产品选择，不套用「损坏数据 Fail-Fast」。
 */
export async function readRoomSettingsMemory<G extends RoomGame>(
  game: G
): Promise<RoomSettingsMemoryByGame[G] | null> {
  return validateRawMemory(game, localStore.get(SETTINGS_PREFIX + game));
}

/** 覆盖写入房间内设置记忆。 */
export function saveRoomSettingsMemory<G extends RoomGame>(
  game: G,
  memory: RoomSettingsMemoryByGame[G]
): void {
  writeJson(SETTINGS_PREFIX + game, memory);
}

let updateQueue: Promise<void> = Promise.resolve();

/**
 * 读取-合并-写回：同一游戏有多个面板各存各的部分时用（如猜歌的题、猜两组）。
 * 读记忆要先校验，是异步的；更新排成一条队依次执行，两个面板几乎同时保存也不会互相覆盖。
 */
export function updateRoomSettingsMemory<G extends RoomGame>(
  game: G,
  patch: (current: RoomSettingsMemoryByGame[G] | null) => RoomSettingsMemoryByGame[G]
): void {
  updateQueue = updateQueue.then(async () => {
    saveRoomSettingsMemory(game, patch(await readRoomSettingsMemory(game)));
  });
}

/** 登记「这个房间刚由本机创建」：进房后的等待页凭它套用上次设置。 */
export function markPendingRestore(game: RoomGame, roomId: string): void {
  localStore.set(RESTORE_PREFIX + game, roomId);
}

/** 读取待恢复的房间号；没有时返回 null。 */
export function peekPendingRestore(game: RoomGame): string | null {
  return localStore.get(RESTORE_PREFIX + game);
}

/**
 * 原子取走待恢复标记：只有与当前房间匹配时才清掉它，并返回房间内设置记忆（可能为空）。
 * 不匹配（标记属于别的房间、或已被消费）时不动存储并返回 null。
 */
export async function takePendingRestoreMemory<G extends RoomGame>(
  game: G,
  roomId: string
): Promise<RoomSettingsMemoryByGame[G] | null> {
  if (localStore.get(RESTORE_PREFIX + game) !== roomId) return null;
  // 标记先同步取走再等校验：并发的第二次挂载拿不到同一份恢复。
  localStore.remove(RESTORE_PREFIX + game);
  return validateRawMemory(game, localStore.get(SETTINGS_PREFIX + game));
}
