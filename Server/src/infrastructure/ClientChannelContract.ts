/**
 * 壳（桌面 Rust、移动 JS 与 Kotlin）与服务端之间无法共享类型，只能共享**同一份取值**：
 * 这里是服务端一侧的权威契约值，路由与校验都从这里取；
 * `test/ShellContract.test.ts` 会读各壳的源码，逐项断言壳里写的字面量与这里一致。
 * 任何一边改了而另一边没改，测试就红——不要只改其中一处。
 *
 * 字段名、枚举与自检词表不在这里重复写：它们的权威就是路由的请求体 schema 与
 * `ClientChannel` 里的自检权重表，对账测试直接读取它们。
 */

/** 通道接口的公共前缀：限流只挂在这个前缀下的写入口上。 */
export const CLIENT_CHANNEL_PATH_PREFIX = "/api/client/";

export const CLIENT_CHANNEL_PATHS = {
  register: "/api/client/register",
  challenge: "/api/client/challenge",
  attest: "/api/client/attest",
  updateCheck: "/api/client/update-check",
  webBundle: "/api/client/web-bundle",
  packages: "/api/client/packages",
} as const;

/** 单个自检 id 的长度上限：壳超长截断后，服务端仍按冒号前的稳定前缀判定。 */
export const CLIENT_SELF_CHECK_ID_MAX_LENGTH = 64;

/** Android 证明链的张数上限：壳最多上报这么多张。 */
export const CLIENT_ATTESTATION_CHAIN_MAX = 8;

/**
 * 壳提前作废票的余量：离过期不足这个时间就当没有，免得票在页面手上才过期。
 * 服务端判票是否过期不用它（只看自己的过期时刻），它只约束壳；两个壳各写一份，靠对账测试守住相等。
 */
export const CLIENT_TICKET_REFRESH_MARGIN_MS = 5_000;
