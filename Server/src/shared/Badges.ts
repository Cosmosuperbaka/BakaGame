// ==================== 身份徽章（前后端唯一来源） ====================

/**
 * 徽章只有管理员人工授予的四种身份，不存在按行为自动解锁的成就：
 * 类型集合、展示文案与顺序都在这里固定，数据库 `badge` 表保存同一份目录用于关系完整性。
 */
export const BADGE_KINDS = ["developer", "contributor", "tester", "sponsor"] as const;
export type BadgeKind = (typeof BADGE_KINDS)[number];

export const BADGE_LABELS: Record<BadgeKind, string> = {
  developer: "开发者",
  contributor: "贡献者",
  tester: "内测",
  sponsor: "赞助",
};

const BADGE_DESCRIPTIONS: Record<BadgeKind, string> = {
  developer: "参与项目核心开发",
  contributor: "为项目提交过代码、文档或设计",
  tester: "参与内测并提供反馈",
  sponsor: "为项目提供赞助",
};

export interface BadgeCatalogEntry {
  id: BadgeKind;
  label: string;
  description: string;
  sortOrder: number;
}

/** 目录顺序即玩家行与后台展示顺序。 */
export const BADGE_CATALOG: readonly BadgeCatalogEntry[] = BADGE_KINDS.map((id, index) => ({
  id,
  label: BADGE_LABELS[id],
  description: BADGE_DESCRIPTIONS[id],
  sortOrder: index + 1,
}));
