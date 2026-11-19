import { AppError } from "../domain/Errors";
import {
  originalNumber,
  originalObject,
  originalString,
} from "../infrastructure/CEEOriginalProtocol";
import { reasonOf, type CEEOriginalContext } from "./CEEOriginalContext";
import type { CEEUpstreamRoom } from "./CEEOriginalModel";
import { originalRoomDisplayName } from "./CEEOriginalView";

export async function fetchRooms(ctx: CEEOriginalContext): Promise<Record<string, unknown>[]> {
  try {
    const response = await ctx.fetcher(new URL("/api/list-rooms", ctx.options.serverUrl), {
      signal: AbortSignal.timeout(8000),
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const payload: unknown = await response.json();
    if (!Array.isArray(payload)) throw new Error("shape");
    return payload.map(originalObject);
  } catch (error) {
    // 对外仍是统一的不可用文案；超时、HTTP 状态与形状错误只进日志，便于分清是哪一种。
    ctx.options.logger?.warn("原版房间列表请求失败", { reason: reasonOf(error) });
    throw new AppError("CEE_ORIGINAL_UNAVAILABLE", "暂时无法连接原版服务器");
  }
}

/** 上游完整房间列表（含非公开房），供统一房号目录分配别名；大厅只展示其中的公开房。 */
export async function listUpstreamRooms(ctx: CEEOriginalContext): Promise<CEEUpstreamRoom[]> {
  if (!ctx.configured) return [];
  return (await fetchRooms(ctx))
    .map((room): CEEUpstreamRoom => ({
      id: originalString(room.id),
      isPublic: room.isPublic === true,
      name: originalRoomDisplayName(
        originalString(room.displayRoomName) || originalString(room.roomName),
        originalString(room.hostName)
      ),
      phase: room.isGameStarted === true ? "guessing" : "waiting",
      playerCount: originalNumber(room.playerCount),
    }))
    .filter((room) => room.id);
}
