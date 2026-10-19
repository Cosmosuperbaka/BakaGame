/**
 * 反作弊相关的集中文案与常量。
 *
 * 错误码 → 文案只写在这一处，组件不再各自拼字符串（AGENTS.md：错误码给具体文案）。
 * 桌面下载地址同样收在这里，将来换域名只改一行。
 */

import type { BadgeProps } from "@/components/ui/Badge";
import type { BakaClientType } from "@/lib/BakaChannel";
import type { AdminAntiCheatReview, AntiCheatReviewStatus } from "@/types";

/**
 * 桌面客户端下载地址；文件名固定，链接随时可换。
 *
 * 路径里的 `files` 是 R2 桶名，不能省：加速域按「第一段路径当桶名」回源，
 * 少了它请求会变成 `InvalidBucketName`（400），玩家拿到的是打不开的链接。
 */
export const BAKA_CLIENT_DOWNLOAD_URL = "https://cdn.baka.website/files/BakaGame-latest-x64.exe";

/**
 * 服务端可归因错误码对应的玩家可读文案。命中这些码时用它替换服务端原文，
 * 未命中的码仍走服务端自带消息。
 *
 * 这三个码既可能来自加入／旁观，也可能来自建房那一刻的开反作弊房请求（反作弊只在建房时决定），
 * 所以措辞按「创建或加入」写，不能只说加入。
 */
const ANTI_CHEAT_MESSAGES: Readonly<Record<string, string>> = {
  CLIENT_REQUIRED: `该房间需要 BakaGame 客户端，请下载安装后再创建或加入：${BAKA_CLIENT_DOWNLOAD_URL}`,
  CLIENT_OUTDATED: `BakaGame 客户端版本过旧，请更新到最新版后再创建或加入：${BAKA_CLIENT_DOWNLOAD_URL}`,
  LOGIN_REQUIRED: "该房间要求登录后再创建、加入或旁观",
  SPECTATE_QUEUE_FULL: "待房主批准的旁观请求已满，请稍后再试",
};

/** 命中反作弊错误码时的专用文案；否则 `undefined`，由调用方回落到服务端消息。 */
export const antiCheatMessage = (code: string): string | undefined =>
  Object.hasOwn(ANTI_CHEAT_MESSAGES, code) ? ANTI_CHEAT_MESSAGES[code] : undefined;

/** 该错误码是否要求打开登录弹窗。 */
export const isLoginRequiredCode = (code: string): boolean => code === "LOGIN_REQUIRED";

// ==================== 旁观批准交互文案 ====================

/** 旁观切换在反作弊房里进入待批准态后，请求者一侧的常驻状态文字。 */
export const SPECTATE_PENDING_TEXT = "等待房主批准";
/** 待批准期间撤销申请、退回参与态的入口文字。 */
export const SPECTATE_CANCEL_TEXT = "取消申请";
/** 房主拒绝（服务端回 `cee.player.spectateResult` 且 `approved` 为假）。 */
export const SPECTATE_REJECTED_TEXT = "房主未同意旁观";
/** 房主同意。 */
export const SPECTATE_APPROVED_TEXT = "房主已同意旁观";
/** 房主始终没处理，服务端兜底超时把身份退回参与。 */
export const SPECTATE_TIMEOUT_TEXT = "旁观申请超时，已退回参与";

/** 房主侧待批准分组的标题与两个动作按钮文字。 */
export const SPECTATE_REQUEST_GROUP_TITLE = "待批准旁观";
export const SPECTATE_APPROVE_LABEL = "同意旁观";
export const SPECTATE_REJECT_LABEL = "拒绝";

/**
 * 客户端旁观待批准的看门狗时长。服务端按 120 秒兜底回收，这里多留几秒余量，
 * 避开「本地计时先到、服务端状态补丁后到」造成的重复提示。
 */
export const SPECTATE_APPROVAL_WATCHDOG_MS = 120_000 + 5_000;

// ==================== 后台复核队列文案 ====================

/** 复核条目的处置状态：只有人能在后台改，代码路径只会写「待复核」。 */
export const ANTI_CHEAT_REVIEW_LABELS: Record<AntiCheatReviewStatus, string> = {
  open: "待复核",
  cleared: "已放行",
  actioned: "已处置",
};

export const ANTI_CHEAT_REVIEW_BADGE: Record<
  AntiCheatReviewStatus,
  NonNullable<BadgeProps["variant"]>
> = {
  open: "subtle",
  cleared: "matched",
  actioned: "restricted",
};

/** 处置按钮文字：与状态标签分开写，点下去落的是「这一条的结论」。 */
export const ANTI_CHEAT_REVIEW_ACTION_LABELS: Record<AntiCheatReviewStatus, string> = {
  open: "退回待复核",
  cleared: "标记放行",
  actioned: "标记已处置",
};

/** 条目来自哪一类客户端；增强房只接受桌面端与移动端，网页出现即为异常。 */
export const CEE_CLIENT_TYPE_LABELS: Record<AdminAntiCheatReview["clientType"], string> = {
  web: "网页",
  desktop: "桌面端",
  mobile: "移动端",
};

// ==================== 首页客户端更新提醒 ====================

/**
 * 首页提醒的正文。门槛是服务端读回的最低版本，措辞写明「只挡反作弊房」：
 * 普通房间照常玩，不能让玩家读成「不更新就打不开游戏」。
 */
export const clientUpdateNoticeText = (
  clientType: Exclude<BakaClientType, "web">,
  minimumVersion: string
): string =>
  `${CEE_CLIENT_TYPE_LABELS[clientType]}版本较旧，更新到 ${minimumVersion} 以上才能进反作弊房；普通房间不受影响。`;

export const CLIENT_UPDATE_DOWNLOAD_LABEL = "下载最新版";
/** 关闭只压到下一次抬档，不是「永不再提醒」，按钮文字据实写「暂不」。 */
export const CLIENT_UPDATE_DISMISS_LABEL = "暂不提醒";

// ==================== 复核条目的跨局视角 ====================

/** 标题里的窗口天数由服务端回读，前端不另写一份常量，免得两侧口径分叉。 */
export const antiCheatHistoryTitle = (windowDays: number): string =>
  `同身份近 ${windowDays} 天的记录`;

/** 这段数字的定位写在标题下：它是上下文，不是第二条判定。 */
export const ANTI_CHEAT_HISTORY_NOTE =
  "均值只把同一个人被记录的回合放在一起看，不参与打分，也不产生任何处置。";
export const ANTI_CHEAT_HISTORY_EMPTY = "窗口内没有其它可比条目。";
export const ANTI_CHEAT_HISTORY_FAILED = "跨局条目读取失败";
/** 一条 CV 都算不出时的取值文字，与本回合特征里的「样本不足」同一口径。 */
export const ANTI_CHEAT_HISTORY_NO_CV = "样本不足";
