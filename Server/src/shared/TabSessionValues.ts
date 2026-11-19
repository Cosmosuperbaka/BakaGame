// ==================== 标签页身份的协议名 ====================
// 客户端从这里取值；本文件不得引入任何 schema 构造模块。

/** 站点连接领取或续用标签页身份：只有这条命令会分配新身份。 */
export const SITE_SESSION_CLAIM_COMMAND = "site.session.claim";
/** 游戏连接挂上同一身份：不分配、不参与冲突判定，只把身份记到这条连接上。 */
export const SITE_SESSION_ATTACH_COMMAND = "site.session.attach";
/** 持有者收到探测后的应答：证明这张标签页真的还开着。 */
export const SITE_SESSION_ALIVE_COMMAND = "site.session.alive";
/** 服务端发给现持有者的探测：另一条连接正拿着同一份身份来领取。 */
export const SITE_SESSION_PROBE_EVENT = "site.session.probe";

/** 32 字节随机数的 base64url：明文只在标签页与首帧之间传递，绝不进 URL。 */
export const TAB_TOKEN_PATTERN = "^[A-Za-z0-9_-]{43}$";
