import { beforeEach, describe, expect, it, vi } from "vitest";

const restarted = vi.hoisted(() => vi.fn(() => false));
vi.mock("@/lib/TabSession", () => ({ serverRestartedRecently: restarted }));

import { permanentRoomErrorMessage, roomIsGone } from "./PermanentRoomError";

describe("永久房间错误的提示文案", () => {
  beforeEach(() => {
    restarted.mockReturnValue(false);
  });

  it.each([
    ["SESSION_NOT_FOUND", "原座位已失效，可能掉线过久或房间已重建"],
    ["SESSION_INVALID", "原座位已失效，可能掉线过久或房间已重建"],
    ["PLAYER_KICKED", "你已被移出房间"],
    ["ROOM_NOT_FOUND", "房间已解散或不存在"],
  ])("%s → %s", (code, text) => {
    expect(permanentRoomErrorMessage({ code, message: "x" })).toBe(text);
  });

  it("服务端刚重启时，房间消失要说清是重启，而不是笼统的失效", () => {
    restarted.mockReturnValue(true);
    expect(permanentRoomErrorMessage({ code: "ROOM_NOT_FOUND", message: "x" })).toBe(
      "服务器已重启，房间未能恢复"
    );
  });
});

describe("恢复失败后房间还能不能回去", () => {
  it.each([
    ["ROOM_NOT_FOUND", true],
    ["PLAYER_KICKED", true],
    ["SESSION_NOT_FOUND", false],
    ["SESSION_INVALID", false],
    ["SESSION_EXPIRED", false],
  ])("%s → %s", (code, gone) => {
    expect(roomIsGone({ code, message: "x" })).toBe(gone);
  });
});
