/**
 * 入房与建房时客户端按服务端错误码分支的几组码表。服务端统一错误码之后只删集合里的旧码，
 * 调用方的分支结构不变。
 */

/** 房号已被占用：卧底与猜歌、增强房目前各回各的，大厅建房撞号时统一按这一组识别。 */
export const ROOM_ID_TAKEN_CODES: ReadonlySet<string> = new Set([
  "ROOM_EXISTS",
  "ROOM_ALREADY_EXISTS",
]);

/** 卧底与猜歌的直链入房：缺密码、密码错误与尝试过多留在密码框并写明原因，其余拒绝提示后回大厅。 */
export const BASIC_PASSWORD_STEP_CODES: ReadonlySet<string> = new Set([
  "PASSWORD_REQUIRED",
  "PASSWORD_INCORRECT",
  "TOO_MANY_ATTEMPTS",
]);
