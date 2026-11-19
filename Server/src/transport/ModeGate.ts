import { AppError } from "../domain/Errors";
import {
  SITE_FEATURE_LABELS,
  type SiteFeatureKey,
  type SiteFeatures,
} from "../shared/SiteFeatures";

interface GateMessage {
  type: string;
  payload?: unknown;
}

/** 闸门只问端点「这条命令要开哪个模式」，不关心它承载的服务。 */
interface ModeEndpoint {
  createMode(message: GateMessage): SiteFeatureKey | undefined;
}

/**
 * 建房闸门：模式被后台临时关闭时拒绝新开房间。
 * 未装配开关（隔离测试、没有数据库的实例）时全部放行，与站点配置的缺省口径一致。
 */
export const assertModeOpen = (
  endpoint: ModeEndpoint,
  message: GateMessage,
  features: (() => SiteFeatures) | undefined
): void => {
  if (!features) return;
  const key = endpoint.createMode(message);
  if (!key || features()[key]) return;
  throw new AppError("MODE_CLOSED", `${SITE_FEATURE_LABELS[key]}暂时关闭，请稍后再来`);
};
