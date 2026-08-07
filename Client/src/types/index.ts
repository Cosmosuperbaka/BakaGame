// ==================== 统一从 @bakagame/shared 导入并导出全量类型 ====================

export * from "@bakagame/shared";

// ==================== 客户端专属类型定义 ====================

export interface VersionInfo {
  name: string;
  version: string;
  commit: string;
  buildTime: string;
}
