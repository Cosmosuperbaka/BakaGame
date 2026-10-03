import { expect, test } from "bun:test";
import type { Static } from "@sinclair/typebox";
import { SongAutoFiltersInputSchema, SongAutoFiltersSchema, type SongAutoFiltersInput, type SongAutoFilters } from "../src/shared/SonGuessrFilters";
import type { SonGuessrClientMessage } from "../src/shared/SonGuessr";
import { parseCCBMessage } from "../src/transport/CCBProtocol";
import { parseWhoIsFakerMessage } from "../src/transport/WhoIsFakerProtocol";
import { parseSonGuessrMessage } from "../src/transport/SonGuessrProtocol";

// 编译期夹具和运行时共用源码，避免解析后的类型虚构完整字段。
const partial: Static<typeof SongAutoFiltersInputSchema> = { playlist: { id: "1" } };
const input: SongAutoFiltersInput = partial;
const state: Static<typeof SongAutoFiltersSchema> = { artists: [], minPopularity: 0 };
const complete: SongAutoFilters = state;
const settings: Extract<SonGuessrClientMessage, { type: "song.room.updateSettings" }> = { id: "partial", type: "song.room.updateSettings", payload: { autoFilters: input } };
// @ts-expect-error 局部筛选不能冒充规范化后的完整房间状态。
const invalidState: SongAutoFilters = partial;
void invalidState;

test("共享筛选输入与状态类型由同一schema导出", () => {
  expect(complete.artists).toEqual([]);
  expect(parseSonGuessrMessage(settings)).toEqual(settings);
});
test("三个协议拒绝继承的原型键且保持明确业务错误", () => {
  for (const parse of [parseWhoIsFakerMessage, parseSonGuessrMessage, parseCCBMessage]) {
    for (const type of ["constructor", "toString", "__proto__"]) {
      try { parse({ id: "prototype", type, payload: {} }); throw new Error("未拒绝原型键"); }
      catch (error) { expect((error as { code?: string }).code).toBe("UNKNOWN_MESSAGE_TYPE"); }
    }
  }
});

// CCB K→payload 关联不能在 Object.fromEntries 后丢失。
import type { CCBClientWireMessage } from "../src/shared/CCB";
const ccbWire: CCBClientWireMessage = { id: "wire", type: "ccb.player.ready", roomId: null, payload: { ready: true } };
// @ts-expect-error ready 命令必须使用 ready 布尔载荷，不能变成任意命令的载荷并集。
const wrongCCBWire: CCBClientWireMessage = { id: "wire", type: "ccb.player.ready", payload: { text: "错误关联" } };
void ccbWire; void wrongCCBWire;
