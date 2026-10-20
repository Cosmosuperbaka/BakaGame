import type { PublicProfile } from "@bakagame/shared";
import { api } from "@/lib/Api";

/**
 * 资料卡缓存：同一访问内按用户 ID 只取一次，失败不缓存（下次打开重试）。
 * 房间快照里的头像地址比缓存新时以快照为准，见 `components/common/ProfileCard`。
 */
const profiles = new Map<string, Promise<PublicProfile>>();

export const loadPublicProfile = (userId: string): Promise<PublicProfile> => {
  let pending = profiles.get(userId);
  if (!pending) {
    pending = api.account.publicProfile({ userId });
    pending.catch(() => profiles.delete(userId));
    profiles.set(userId, pending);
  }
  return pending;
};

/** 本人改了资料（昵称、QQ 公开）后作废，下次打开资料卡重新读取。 */
export const invalidatePublicProfile = (userId: string) => profiles.delete(userId);

/** 仅测试使用。 */
export const clearProfileCacheForTest = () => profiles.clear();
