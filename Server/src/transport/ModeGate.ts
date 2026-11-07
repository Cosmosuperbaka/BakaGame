import { AppError } from "../domain/Errors";
import type { GameId } from "../shared/Protocol";
import {
  SITE_FEATURE_LABELS,
  type SiteFeatureKey,
  type SiteFeatures,
} from "../shared/SiteFeatures";

interface GateMessage {
  type: string;
  payload?: unknown;
}

/**
 * 这条消息要新开哪个模式的房间；不是建房命令时返回 `undefined`。
 *
 * 只拦建房：加入已有房间、断线重连和局内命令一律放行，关掉模式时正在玩的人能把这局打完。
 * 排位不经过这里，它的开关只管首页入口（见 `SiteFeatures`）。
 */
export const modeOfCreate = (game: GameId, message: GateMessage): SiteFeatureKey | undefined => {
  if (game === "faker") return message.type === "room.create" ? "fakerEntry" : undefined;
  if (game === "song") {
    if (message.type !== "song.room.create") return undefined;
    const solo = (message.payload as { solo?: unknown } | undefined)?.solo === true;
    return solo ? "songSoloEntry" : "songMultiplayerEntry";
  }
  // 增强房与原版房共用一个开关：玩家在同一个大厅里看到的都是「多人模式」。
  return message.type === "cee.room.create" ? "ceeMultiplayerEntry" : undefined;
};

/**
 * 建房闸门：模式被后台临时关闭时拒绝新开房间。
 * 未装配开关（隔离测试、没有数据库的实例）时全部放行，与站点配置的缺省口径一致。
 */
export const assertModeOpen = (
  game: GameId,
  message: GateMessage,
  features: (() => SiteFeatures) | undefined
): void => {
  if (!features) return;
  const key = modeOfCreate(game, message);
  if (!key || features()[key]) return;
  throw new AppError("MODE_CLOSED", `${SITE_FEATURE_LABELS[key]}暂时关闭，请稍后再来`);
};
