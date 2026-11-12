import { AppError } from "../../domain/Errors";

/**
 * 读正数环境变量（调用方传入环境变量的原值，注册表测试靠调用处的字面读取核对变量名）：未设置（或空串）取缺省，写错直接以配置错误中断。
 * `Number("abc")` 得到 NaN 会一路流进限速与间隔计算，静默失效比启动失败更难排查。
 */
export const readPositiveNumber = (
  name: string,
  rawValue: string | undefined,
  fallback: number
): number => {
  const raw = rawValue?.trim();
  if (!raw) return fallback;
  const value = Number(raw);
  if (!Number.isFinite(value) || value <= 0)
    throw new AppError("CONFIG_ERROR", `环境变量 ${name} 必须为正数，收到: "${raw}"`);
  return value;
};
