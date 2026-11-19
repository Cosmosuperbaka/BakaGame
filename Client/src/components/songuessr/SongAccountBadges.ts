import type { SongMusicPlatform } from "@/lib/SonGuessrMusicSession";
import type { SonGuessrMusicAccount } from "@bakagame/shared";

/** 黑胶与绿钻成长等级在官方徽章上的写法。 */
const LEVEL_NUMERALS = ["", "壹", "贰", "叁", "肆", "伍", "陆", "柒", "捌"];

/** 官方会员徽章：图片取自 CDN 原图（`public/assets/netease-vip` 和 `public/assets/qqmusic-vip`），读屏读档位与等级。
 *  路径必须写成完整静态字符串：构建期的 WebP 转换只做精确字符串替换，模板拼接会漏进产物，被 asset-smoke 拦下。 */
const NETEASE_VIP_BADGE_SRC: Record<"svip" | "vip", string[]> = {
  svip: [
    "",
    "/assets/netease-vip/SVIP-1.png",
    "/assets/netease-vip/SVIP-2.png",
    "/assets/netease-vip/SVIP-3.png",
    "/assets/netease-vip/SVIP-4.png",
    "/assets/netease-vip/SVIP-5.png",
    "/assets/netease-vip/SVIP-6.png",
    "/assets/netease-vip/SVIP-7.png",
  ],
  vip: [
    "",
    "/assets/netease-vip/VIP-1.png",
    "/assets/netease-vip/VIP-2.png",
    "/assets/netease-vip/VIP-3.png",
    "/assets/netease-vip/VIP-4.png",
    "/assets/netease-vip/VIP-5.png",
    "/assets/netease-vip/VIP-6.png",
    "/assets/netease-vip/VIP-7.png",
  ],
};

const QQ_VIP_BADGE_SRC: {
  svip: string[];
  svipYear: string[];
  vip: string[];
  vipYear: string[];
} = {
  svip: [
    "",
    "/assets/qqmusic-vip/SVIP-1.png",
    "/assets/qqmusic-vip/SVIP-2.png",
    "/assets/qqmusic-vip/SVIP-3.png",
    "/assets/qqmusic-vip/SVIP-4.png",
    "/assets/qqmusic-vip/SVIP-5.png",
    "/assets/qqmusic-vip/SVIP-6.png",
    "/assets/qqmusic-vip/SVIP-7.png",
    "/assets/qqmusic-vip/SVIP-8.png",
    "/assets/qqmusic-vip/SVIP-9.png",
    "/assets/qqmusic-vip/SVIP-10.png",
  ],
  svipYear: [
    "",
    "/assets/qqmusic-vip/SVIP-1-Year.png",
    "/assets/qqmusic-vip/SVIP-2-Year.png",
    "/assets/qqmusic-vip/SVIP-3-Year.png",
    "/assets/qqmusic-vip/SVIP-4-Year.png",
    "/assets/qqmusic-vip/SVIP-5-Year.png",
    "/assets/qqmusic-vip/SVIP-6-Year.png",
    "/assets/qqmusic-vip/SVIP-7-Year.png",
    "/assets/qqmusic-vip/SVIP-8-Year.png",
    "/assets/qqmusic-vip/SVIP-9-Year.png",
    "/assets/qqmusic-vip/SVIP-10-Year.png",
  ],
  vip: [
    "",
    "/assets/qqmusic-vip/VIP-1.png",
    "/assets/qqmusic-vip/VIP-2.png",
    "/assets/qqmusic-vip/VIP-3.png",
    "/assets/qqmusic-vip/VIP-4.png",
    "/assets/qqmusic-vip/VIP-5.png",
    "/assets/qqmusic-vip/VIP-6.png",
    "/assets/qqmusic-vip/VIP-7.png",
    "/assets/qqmusic-vip/VIP-8.png",
    "/assets/qqmusic-vip/VIP-9.png",
    "/assets/qqmusic-vip/VIP-10.png",
  ],
  vipYear: [
    "",
    "/assets/qqmusic-vip/VIP-1-Year.png",
    "/assets/qqmusic-vip/VIP-2-Year.png",
    "/assets/qqmusic-vip/VIP-3-Year.png",
    "/assets/qqmusic-vip/VIP-4-Year.png",
    "/assets/qqmusic-vip/VIP-5-Year.png",
    "/assets/qqmusic-vip/VIP-6-Year.png",
    "/assets/qqmusic-vip/VIP-7-Year.png",
    "/assets/qqmusic-vip/VIP-8-Year.png",
    "/assets/qqmusic-vip/VIP-9-Year.png",
    "/assets/qqmusic-vip/VIP-10-Year.png",
  ],
};

export type VipBadge = { src: string; label: string; platform: SongMusicPlatform };

function qqVipBadge(account: SonGuessrMusicAccount): VipBadge | null {
  const level = Math.min(Math.max(account.vipLevel ?? 1, 1), 10);
  const isYear = Boolean(account.vipYear);
  if (account.vipTier === "svip") {
    return {
      src: isYear ? QQ_VIP_BADGE_SRC.svipYear[level] : QQ_VIP_BADGE_SRC.svip[level],
      label: `${isYear ? "年费超级会员" : "超级会员"} · SVIP${level}`,
      platform: "qq",
    };
  }
  if (account.vipTier === "vip") {
    return {
      src: isYear ? QQ_VIP_BADGE_SRC.vipYear[level] : QQ_VIP_BADGE_SRC.vip[level],
      label: `${isYear ? "年费绿钻" : "豪华绿钻"} · LV${level}`,
      platform: "qq",
    };
  }
  return null;
}

function neteaseVipBadge(account: SonGuessrMusicAccount): VipBadge | null {
  const level = Math.min(Math.max(account.vipLevel ?? 1, 1), 7);
  if (account.vipTier === "svip")
    return {
      src: NETEASE_VIP_BADGE_SRC.svip[level],
      label: `SVIP · ${LEVEL_NUMERALS[level]}`,
      platform: "netease",
    };
  if (account.vipTier === "vip")
    return {
      src: NETEASE_VIP_BADGE_SRC.vip[level],
      label: `VIP · ${LEVEL_NUMERALS[level]}`,
      platform: "netease",
    };
  if (account.vipTier === "musicPackage")
    return { src: "/assets/netease-vip/musicPackage.png", label: "音乐包", platform: "netease" };
  return null;
}

export function vipBadge(account: SonGuessrMusicAccount): VipBadge | null {
  return account.platform === "qq" ? qqVipBadge(account) : neteaseVipBadge(account);
}

const expireFormat = new Intl.DateTimeFormat("zh-CN", {
  year: "numeric",
  month: "numeric",
  day: "numeric",
  timeZone: "Asia/Shanghai",
});

/** 会员一行的文字：徽章之后的到期日；旧版本存下的账号没有档位时退回文字。 */
export function vipText(account: SonGuessrMusicAccount): {
  label: string;
  expire: string;
  description?: string;
} {
  const isQq = account.platform === "qq";
  const platformName = isQq ? "QQ音乐" : "网易云";
  const expire =
    account.vipStatus === "vip" && account.vipExpireTime
      ? `${expireFormat.format(new Date(account.vipExpireTime))} 到期`
      : "";
  if (account.vipStatus === "vip")
    return { label: vipBadge(account)?.label ?? `${platformName}会员`, expire };
  if (account.vipStatus === "nonVip")
    return {
      label: "非会员",
      expire,
      description: "非会员账号也能出题，会员专享歌曲会自动匹配可用音源。",
    };
  return {
    label: "会员状态未知",
    expire,
    description: `暂时无法读取会员状态，选歌时以${platformName}实际权限为准。`,
  };
}
