/**
 * 生成 4 位随机数字房间号
 */
export function randomRoomId(): string {
  return String(Math.floor(1000 + Math.random() * 9000));
}
