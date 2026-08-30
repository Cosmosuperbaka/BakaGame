// ==================== 统一业务错误 ====================

export class AppError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly details?: unknown,
  ) {
    super(message);
    this.name = "AppError";
  }
}

// WebSocket 入口会优先把业务错误映射成可预期的 error 包。
export const isAppError = (error: unknown): error is AppError =>
  error instanceof AppError;
