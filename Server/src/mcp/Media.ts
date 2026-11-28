/**
 * 工具结果里随文本一起回给 Agent 的媒体内容块（MCP `audio` 内容）。
 *
 * 挂在结果对象的不可枚举符号属性上：`JSON.stringify` 与对象展开都不会带上它，
 * 文本部分与原来逐字节一致；两个入口在协议内核里把它取出来另起内容块。
 */
export interface ToolMedia {
  type: "audio";
  mimeType: string;
  /** base64 编码的数据。 */
  data: string;
}

const MEDIA = Symbol("bakagame.mcp.media");

export const attachMedia = <T extends object>(value: T, media: readonly ToolMedia[]): T => {
  if (media.length > 0)
    Object.defineProperty(value, MEDIA, {
      value: [...media],
      enumerable: false,
      configurable: true,
    });
  return value;
};

export const mediaOf = (value: unknown): ToolMedia[] => {
  if (typeof value !== "object" || value === null) return [];
  const media = (value as Record<symbol, unknown>)[MEDIA];
  return Array.isArray(media) ? (media as ToolMedia[]) : [];
};
