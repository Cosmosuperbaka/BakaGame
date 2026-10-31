import { AppError } from "../domain/Errors";
import type { ConnectionRecord } from "../shared/Index";

export type CEEClientAdmissionPurpose = "antiCheatRoom" | "ranked";

/**
 * 连接级准入：通道证明、版本不过低、已登录；排位另外拒绝 Agent 连接。
 *
 * 反作弊房与排位共用「只有真客户端 + 已登录」这条底线，判据集中一处，
 * 免得两个入口各抄一份后顺序与文案各自漂移。
 */
export function requireCEEClientAdmission(
  connection: ConnectionRecord,
  purpose: CEEClientAdmissionPurpose
): void {
  if (purpose === "ranked") {
    if (connection.isAgent === true)
      throw new AppError("AGENTS_NOT_ALLOWED", "排位赛不允许 Agent 接入");
    if (!connection.clientChannel)
      throw new AppError("CLIENT_REQUIRED", "排位赛需要使用 BakaGame 客户端");
    if (connection.clientChannel.outdated)
      throw new AppError("CLIENT_OUTDATED", "客户端版本过低，请更新后再进行排位");
    if (!connection.account) throw new AppError("LOGIN_REQUIRED", "排位赛需要先登录");
    return;
  }
  if (!connection.clientChannel)
    // 无票与票被拒都落在这里，原因由 ClientChannel.consume 的日志区分；给玩家的文案
    // 只说明「这条连接没有客户端通道」，不臆断是网页、过期还是地址不符。
    throw new AppError("CLIENT_REQUIRED", "当前连接没有客户端通道证明，请使用客户端重新进入游戏");
  // 强制更新只拦这类房间：旧壳在普通房照常玩，协议变更不该波及他们。
  if (connection.clientChannel.outdated)
    throw new AppError("CLIENT_OUTDATED", "客户端版本过低，请更新后再创建该房间");
  if (!connection.account) throw new AppError("LOGIN_REQUIRED", "创建反作弊房间要求已登录");
}
