import { expect, test } from "bun:test";
import { Kind, Type as t } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
import { TypeCompiler } from "@sinclair/typebox/compiler";
import type { createApp } from "../src/transport/App";
import { schemaUnion } from "../src/shared/SchemaUnion";

type Assert<T extends true> = T;
type IsAny<T> = 0 extends (1 & T) ? true : false;
type IsNever<T> = [T] extends [never] ? true : false;
type Routes = ReturnType<typeof createApp>["app"]["~Routes"];
type FakerBody = Routes["api"]["whoisfaker"]["ws"]["subscribe"]["body"];
type SongBody = Routes["api"]["songuessr"]["ws"]["subscribe"]["body"];
type CCBBody = Routes["api"]["ccb"]["ws"]["subscribe"]["body"];
type FakerResponse = Routes["api"]["whoisfaker"]["ws"]["subscribe"]["response"][200];
export type PacketKind = Assert<FakerResponse["type"] extends "ack" | "error" | "event" ? true : false>;
export type AckId = Assert<Extract<FakerResponse, { type: "ack" }>["id"] extends string ? true : false>;
export type ErrorCode = Assert<Extract<FakerResponse, { type: "error" }>["error"]["code"] extends string ? true : false>;
// @ts-expect-error 事件 payload 尚未声明业务状态类型，不能冒充完整端到端安全。
export type EventRoomId = Extract<FakerResponse, { type: "event" }>["payload"]["roomId"];
type Ready = Routes["readyz"]["get"]["response"];
export type ReadySuccess = Assert<Ready[200]["ready"] extends true ? true : false>;
export type ReadyFailure = Assert<Ready[503]["ready"] extends false ? true : false>;
export type ReadyFailureReason = Assert<Ready[503]["status"] extends "shutting_down" | "storage_degraded" ? true : false>;
export type NotAny = Assert<IsAny<FakerBody | SongBody | CCBBody> extends false ? true : false>;
export type NotNever = Assert<IsNever<FakerBody> | IsNever<SongBody> | IsNever<CCBBody> extends false ? true : false>;
const faker: FakerBody = { id: "compile", type: "game.submitDescription", payload: { text: "描述" } };
const song: SongBody = { id: "compile", type: "song.auth.qr.check", payload: { key: "key" } };
const ccb: CCBBody = { id: "compile", type: "ccb.game.guess", payload: { characterId: 1 } };
// @ts-expect-error 卧底描述必须为文本。
const wrongFaker: FakerBody = { id: "compile", type: "game.submitDescription", payload: { text: 1 } };
// @ts-expect-error 扫码 key 必须为字符串。
const wrongSong: SongBody = { id: "compile", type: "song.auth.qr.check", payload: { key: false } };
// @ts-expect-error CCB 角色标识是数字。
const wrongCCB: CCBBody = { id: "compile", type: "ccb.game.guess", payload: { characterId: "not-a-number" } };
// @ts-expect-error 未声明命令不得进入输入联合。
const unknown: FakerBody = { id: "compile", type: "unknown.command", payload: {} };
void [faker, song, ccb, wrongFaker, wrongSong, wrongCCB, unknown];

test("动态 union 使用同 Schema 的 Static，保留原生 Union 运行校验", () => {
  const schemas = [t.String(), t.Number()];
  const union = schemaUnion(schemas);
  expect(union[Kind]).toBe("Union");
  expect(union.anyOf).toEqual(schemas);
  const validator = TypeCompiler.Compile(union);
  for (const input of ["string", 2]) {
    expect(Value.Check(union, input)).toBe(true);
    expect(validator.Check(input)).toBe(true);
  }
  for (const input of [null, false, {}, []]) {
    expect(Value.Check(union, input)).toBe(false);
    expect(validator.Check(input)).toBe(false);
  }
});
