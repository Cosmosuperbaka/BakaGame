import { createHmac } from "node:crypto";
import type { GameId } from "../shared/Protocol";
import type { ConnectionRecord } from "../shared/Model";

/**
 * 标签页在某一间房里的玩家号。
 *
 * 玩家号是公开标识，会随快照、聊天与历史发给房间里的每个人，所以它只能是单向派生：
 * 拿到它既反推不出标签页身份，也换算不出同一张标签页在别的房间的号。
 * 派生而不是另存映射：退房后席位记录已删，再进来必须还是同一个人，
 * 而这份确定性不依赖任何房间状态，服务端重启后同样成立。
 *
 * 前缀不能与房间快照恢复时按 `player_<base36>` 回收计数器的规则相撞，否则计数器会被哈希值撑爆。
 * 没有标签页身份的连接（旧客户端、Agent）返回 undefined，由各服务按原有方式发号。
 */
export const tabSeatId = (
  connection: Pick<ConnectionRecord, "tabKey">,
  game: GameId,
  roomId: string
): string | undefined => {
  if (!connection.tabKey) return undefined;
  const digest = createHmac("sha256", connection.tabKey).update(`${game}:${roomId}`).digest("hex");
  return `tab_${digest.slice(0, 32)}`;
};
