// ==================== 统一从 @bakagame/shared 导入并导出全量类型 ====================

export * from "@bakagame/shared";
import type { RoomSummary } from "@bakagame/shared";

/** 兼容大厅房间摘要名称 */
export type RoomSummaryItem = RoomSummary;

// ==================== 客户端专属类型定义 ====================

export interface VersionInfo {
  name: string;
  version: string;
  commit: string;
  buildTime: string;
}
