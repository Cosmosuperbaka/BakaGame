// ==================== 客户端运行时值的唯一入口 ====================
// 客户端只能从这里引入共享运行时代码：本文件及其引用的模块不得直接或间接加载
// `@sinclair/typebox` 或任何会构造 schema 的模块，否则校验库会整体打进浏览器包。
// 类型仍从 `@bakagame/shared` 走 `import type`，编译时会被擦除。
//
// 已经不含 schema 的既有模块（Account / Badges / ChatWindow / Protocol / Status）
// 直接在此列出；其余值从对应的纯值模块取。

export {
  AUTH_BASE_PATH,
  FEEDBACK_CONTENT_MAX_LENGTH,
  FEEDBACK_REPLY_MAX_LENGTH,
  FEEDBACK_TITLE_MAX_LENGTH,
  LOGIN_CODE_LENGTH,
  LOGIN_CODE_PATTERN,
  LOGIN_CODE_TTL_SECONDS,
  PREFERENCES_MAX_BYTES,
  QQ_NUMBER_PATTERN,
  qlogoUrlOf,
  qqEmailOf,
} from "./Account";
export { PIONEER_BADGE_LIMIT, badgeDescriptionOf, badgeLabelOf } from "./Badges";
export { createDefaultCEESettings } from "./CEEDefaults";
export {
  CEE_RANKED_BOT_DAILY_RATED,
  CEE_RANKED_BOT_FALLBACK_MS,
  CEE_RANKED_BOT_OPTION_MS,
  CEE_RANKED_PLACEMENT_SERIES,
  CEE_RANKED_SERIES_GAMES,
  CEE_RANKED_SERIES_WIN_POINTS,
  CEE_RANKED_TIERS,
  ceeRankedTier,
} from "./CEERankedValues";
export { CLIENT_CHAT_WINDOW, mergeChatWindow } from "./ChatWindow";
export {
  isValidRoomId,
  isPermanentRoomError,
  protocolErrorCode,
  ROOM_ID_TEST_MODE,
} from "./ModelValues";
export { SERVER_SHUTDOWN_MESSAGE } from "./Protocol";
export {
  ALL_BANGUMI_TRACK_KINDS,
  BANGUMI_TRACK_KIND_LABELS,
  refineTrackKindByText,
  SONG_CLIP_MIN_MS,
  SONG_QUESTION_TYPE_LABELS,
  hasMusicAccount,
} from "./SonGuessrValues";
export {
  PUBLIC_STATUS_COMPONENT_IDS,
  PUBLIC_STATUS_GROUP_IDS,
  PUBLIC_STATUS_GROUPS,
} from "./Status";
export { ABSTAIN_TARGET_ID } from "./WhoIsFakerValues";
