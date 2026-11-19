import { Type as t } from "@sinclair/typebox";
import { TAB_TOKEN_PATTERN } from "./TabSessionValues";

export * from "./TabSessionValues";

const strict = { additionalProperties: false };
const token = t.String({ pattern: TAB_TOKEN_PATTERN });

export const TabSessionClaimSchema = t.Object({ token: t.Optional(token) }, strict);
export const TabSessionAttachSchema = t.Object({ token }, strict);
export const TabSessionAliveSchema = t.Object(
  { nonce: t.String({ minLength: 1, maxLength: 64 }) },
  strict
);

export interface TabSessionClaimAck {
  token: string;
  /** 带来的身份正被另一张开着的标签页使用：这里给的是新身份，旧身份的本地痕迹要全部丢弃。 */
  rotated: boolean;
  /** 进程级随机号：变了就说明服务端重启过，客户端据此把房间消失讲清楚。 */
  serverEpoch: string;
}
