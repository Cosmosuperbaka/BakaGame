// ==================== 统一业务错误 ====================

export class AppError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly details?: unknown
  ) {
    super(message);
    this.name = "AppError";
  }
}

// WebSocket 入口会优先把业务错误映射成可预期的 error 包。
export const isAppError = (error: unknown): error is AppError => error instanceof AppError;

/**
 * 命令名已过协议校验但本玩法没有实现分支时使用（switch default）。
 * 三款游戏共用：协议层放行、服务层没有对应 case 属于同一种错误，不该各写一份。
 */
export const unsupportedCommand = (): never => {
  throw new AppError("UNSUPPORTED_COMMAND", "暂不支持的命令");
};
