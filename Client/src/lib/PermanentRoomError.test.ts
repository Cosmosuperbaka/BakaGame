import { describe, expect, it } from "vitest";
import { permanentRoomErrorMessage } from "./PermanentRoomError";

describe("永久房间错误的提示文案", () => {
  it.each([
    ["SESSION_NOT_FOUND", "会话已失效，请重新加入"],
    ["SESSION_INVALID", "会话已失效，请重新加入"],
    ["PLAYER_KICKED", "你已被移出房间"],
    ["ROOM_NOT_FOUND", "房间已解散或不存在"],
  ])("%s → %s", (code, text) => {
    expect(permanentRoomErrorMessage({ code, message: "x" })).toBe(text);
  });
});
