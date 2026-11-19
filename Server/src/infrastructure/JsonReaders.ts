/**
 * JSON / record 读取的通用窄化与稳定序列化。
 *
 * 平台中立的基础设施：网易云、QQ 音乐等上游适配层共享同一份实现，
 * 不引入任何平台专有概念。
 */
export const asRecord = (value: unknown): Record<string, unknown> =>
  value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};

export const asArray = (value: unknown): unknown[] => (Array.isArray(value) ? value : []);

// 对象键序无关的稳定序列化：用于把 cookie 对象映射成稳定的 IP scope，
// 避免 JSON.stringify 受插入顺序影响导致同一登录态算出不同 IP。
export const stableStringify = (value: unknown): string => {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "";
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  const record = value as Record<string, unknown>;
  const entries = Object.keys(record)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${stableStringify(record[key])}`);
  return `{${entries.join(",")}}`;
};

export const readString = (value: unknown): string | undefined => {
  if (typeof value === "string" && value.trim()) return value.trim();
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  return undefined;
};

export const readNumber = (value: unknown): number | undefined =>
  typeof value === "number" && Number.isFinite(value) ? value : undefined;
