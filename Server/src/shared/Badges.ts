// ==================== 身份徽章（前后端唯一来源） ====================

/**
 * 徽章是身份标识，不是按行为解锁的成就：
 * - `owner` 只由系统授予最高管理员；
 * - `contributor` 只由管理员人工授予；
 * - `pioneer` 在注册时按序号自动授予最早注册的一批用户（名额见 `PIONEER_BADGE_LIMIT`）。
 * 类型集合、展示文案与顺序都在这里固定，数据库 `badge` 表保存同一份目录用于关系完整性。
 */
export const BADGE_KINDS = ["owner", "contributor", "pioneer"] as const;
export type BadgeKind = (typeof BADGE_KINDS)[number];

/** 先行者只覆盖最早注册的这一批账号。 */
export const PIONEER_BADGE_LIMIT = 1000;

export const BADGE_LABELS: Record<BadgeKind, string> = {
  owner: "主理人",
  contributor: "贡献者",
  pioneer: "先行者",
};

export const BADGE_DESCRIPTIONS: Record<BadgeKind, string> = {
  owner: "BakaGame的第一因",
  contributor: "为BakaGame做出卓越贡献的玩家",
  pioneer: "BakaGame最早的一批注册用户",
};

/** 一枚已授予的徽章；先行者带注册序号，其余徽章没有序号。 */
export interface AccountBadge {
  kind: BadgeKind;
  serial: number | null;
}

/**
 * 先行者序号可展示：只有名额内的序号才有意义。超出名额说明序号被历史跳号写坏，
 * 宁可退回不带序号的文案，也不把明显不对的数字给玩家看。
 */
const pioneerSerialOf = (badge: AccountBadge): number | null =>
  badge.kind === "pioneer" &&
  badge.serial !== null &&
  Number.isInteger(badge.serial) &&
  badge.serial >= 1 &&
  badge.serial <= PIONEER_BADGE_LIMIT
    ? badge.serial
    : null;

/** 展示文案：先行者把注册序号写进名字，如「先行者·№42」。 */
export const badgeLabelOf = (badge: AccountBadge): string => {
  const serial = pioneerSerialOf(badge);
  return serial === null ? BADGE_LABELS[badge.kind] : `${BADGE_LABELS.pioneer}·№${serial}`;
};

/** 悬停描述；先行者按持有人的实际注册序号生成。 */
export const badgeDescriptionOf = (badge: AccountBadge): string => {
  const serial = pioneerSerialOf(badge);
  return serial === null ? BADGE_DESCRIPTIONS[badge.kind] : `BakaGame的第${serial}位注册用户`;
};

export interface BadgeCatalogEntry {
  id: BadgeKind;
  label: string;
  description: string;
  sortOrder: number;
}

/** 目录顺序即玩家行与管理后台的展示顺序。 */
export const BADGE_CATALOG: readonly BadgeCatalogEntry[] = BADGE_KINDS.map((id, index) => ({
  id,
  label: BADGE_LABELS[id],
  description: BADGE_DESCRIPTIONS[id],
  sortOrder: index + 1,
}));
