import { expect, test } from "bun:test";
import { createAck, createErrorPacket, createEvent } from "../src/transport/Packets";

test("确认帧带服务端当前时刻，用于客户端估算时钟偏差", () => {
  const before = Date.now();
  const ack = createAck({ id: "a1", type: "chat.send" }, { ok: true });
  const after = Date.now();

  expect(typeof ack.serverNow).toBe("number");
  expect(ack.serverNow).toBeGreaterThanOrEqual(before);
  expect(ack.serverNow).toBeLessThanOrEqual(after);
});

test("服务端时刻只随确认帧下发，事件帧与错误帧不带", () => {
  expect("serverNow" in createEvent("room.snapshot", {})).toBe(false);
  expect("serverNow" in createErrorPacket("e1", "CODE", "message")).toBe(false);
});
