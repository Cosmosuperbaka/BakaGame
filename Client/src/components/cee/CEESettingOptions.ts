import type { CEEAnswerMode } from "@bakagame/shared";
import type { SegmentedOption } from "@/components/ui/SegmentedControl";

export const CATEGORIES = [
  "",
  "全部",
  "游戏",
  "书籍",
  "三次元",
  "TV",
  "Galgame",
  "WEB",
  "OVA",
  "剧场版",
  "动态漫画",
  "其他",
];
export const SOURCES = ["", "原创", "漫画改", "游戏改", "小说改"];
export const GENRES = [
  "",
  "科幻",
  "喜剧",
  "百合",
  "校园",
  "惊悚",
  "后宫",
  "机战",
  "悬疑",
  "恋爱",
  "奇幻",
  "推理",
  "运动",
  "耽美",
  "音乐",
  "战斗",
  "冒险",
  "萌系",
  "穿越",
  "玄幻",
  "乙女",
  "恐怖",
  "历史",
  "日常",
  "剧情",
  "武侠",
  "美食",
  "职场",
];
export const META_TAGS = [
  { label: "作品分类", values: CATEGORIES, all: "全部动画" },
  { label: "作品来源", values: SOURCES, all: "全部来源" },
  { label: "作品题材", values: GENRES, all: "全部题材" },
] as const;
export const ANSWER_MODE_OPTIONS: SegmentedOption<CEEAnswerMode>[] = [
  { value: "random", label: "随机出题" },
  { value: "manual", label: "指定出题人" },
];
/** 玩法配置文件的大小上限：正常配置只有几 KB，拒绝异常大的文件。 */
export const SETTINGS_FILE_LIMIT = 100_000;
export const MAX_ADDED_SUBJECTS = 500;
