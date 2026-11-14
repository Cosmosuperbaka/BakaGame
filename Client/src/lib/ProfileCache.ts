import type { PublicProfile } from "@bakagame/shared";
import { api } from "@/lib/Api";
import { createPromiseCache } from "@/lib/PromiseCache";

/**
 * 资料卡缓存：同一访问内按用户 ID 只取一次，失败不缓存（下次打开重试）。
 * 房间快照里的头像地址比缓存新时以快照为准，见 `components/common/ProfileCard`。
 */
const profiles = createPromiseCache<string, PublicProfile>((userId) =>
  api.account.publicProfile({ userId })
);

export const loadPublicProfile = profiles.get;

/** 本人改了资料（昵称、QQ 公开）后作废，下次打开资料卡重新读取。 */
export const invalidatePublicProfile = profiles.invalidate;

/** 仅测试使用。 */
export const clearProfileCacheForTest = profiles.clear;
