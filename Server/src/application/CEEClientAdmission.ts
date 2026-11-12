import { AppError } from "../domain/Errors";
import type { ConnectionRecord } from "../shared/Index";

export type CEEClientAdmissionPurpose = "antiCheatRoom" | "ranked";

/** 各场景的拒绝文案：判据与顺序只有一份，这里只区分说法。 */
interface AdmissionTexts {
  /** 非空表示连接本身是 Agent 也一并拒绝（排位）；反作弊房只拦被接管的标签页。 */
  agentConnection: string | null;
  clientRequired: string;
  outdated: string;
  loginRequired: string;
}

const ADMISSION_TEXTS: Record<CEEClientAdmissionPurpose, AdmissionTexts> = {
  ranked: {
    agentConnection: "排位赛不允许 Agent 接入",
    clientRequired: "排位赛需要使用 BakaGame 客户端",
    outdated: "客户端版本过低，请更新后再进行排位",
    loginRequired: "排位赛需要先登录",
  },
  // 无票与票被拒都落在 clientRequired：原因由 ClientChannel.consume 的日志区分；给玩家的文案
  // 只说明「这条连接没有客户端通道」，不臆断是网页、过期还是地址不符。
  antiCheatRoom: {
    agentConnection: null,
    clientRequired: "当前连接没有客户端通道证明，请使用客户端重新进入游戏",
    // 强制更新只拦这类房间：旧壳在普通房照常玩，协议变更不该波及他们。
    outdated: "客户端版本过低，请更新后再创建该房间",
    loginRequired: "创建反作弊房间要求已登录",
  },
};

/**
 * 连接级准入：通道证明、版本不过低、已登录；被接管的标签页一律不进，排位另外拒绝 Agent 连接。
 *
 * 反作弊房与排位共用「只有真客户端 + 已登录」这条底线，判据只在这一处，
 * 场景之间只有文案不同，免得两个入口各抄一份后顺序与判据各自漂移。
 */
export function requireCEEClientAdmission(
  connection: ConnectionRecord,
  purpose: CEEClientAdmissionPurpose
): void {
  const texts = ADMISSION_TEXTS[purpose];
  if (connection.agentDriven?.() === true)
    throw new AppError("AGENTS_NOT_ALLOWED", "这里不允许 Agent 操作");
  if (texts.agentConnection !== null && connection.isAgent === true)
    throw new AppError("AGENTS_NOT_ALLOWED", texts.agentConnection);
  if (!connection.clientChannel) throw new AppError("CLIENT_REQUIRED", texts.clientRequired);
  if (connection.clientChannel.outdated) throw new AppError("CLIENT_OUTDATED", texts.outdated);
  if (!connection.account) throw new AppError("LOGIN_REQUIRED", texts.loginRequired);
}
