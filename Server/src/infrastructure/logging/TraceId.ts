const ZERO_TRACE = "0".repeat(32);

/** 调用方自带的追踪号只认两种形状：UUID（客户端生成）或 32 位十六进制（W3C 与 Sentry 的 trace-id）。 */
const UUID_SHAPE = /^[\da-f]{8}-[\da-f]{4}-[\da-f]{4}-[\da-f]{4}-[\da-f]{12}$/;
const HEX32_SHAPE = /^[\da-f]{32}$/;

/**
 * 校验不可信来源（请求头、WS 信封）给的追踪号：形状合格才原样沿用（归一成小写），
 * 其余一律视为没有。追踪号会进日志、OTLP 与 Sentry 标签，放任任意字符串进来既能污染链路检索，
 * 也能让超长或带控制字符的内容长期留在第三方平台。
 */
export const acceptTraceId = (value: string | null | undefined): string | undefined => {
  const candidate = value?.trim().toLowerCase();
  if (!candidate) return undefined;
  if (candidate === ZERO_TRACE) return undefined;
  return UUID_SHAPE.test(candidate) || HEX32_SHAPE.test(candidate) ? candidate : undefined;
};
