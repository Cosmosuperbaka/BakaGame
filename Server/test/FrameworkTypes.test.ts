import { expect, test } from "bun:test";
import { Kind, Type as t } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
import { TypeCompiler } from "@sinclair/typebox/compiler";
import type { createApp } from "../src/transport/App";
import { schemaUnion } from "../src/shared/SchemaUnion";

type Assert<T extends true> = T;
type IsAny<T> = 0 extends 1 & T ? true : false;
type IsNever<T> = [T] extends [never] ? true : false;
type Routes = ReturnType<typeof createApp>["app"]["~Routes"];
type FakerBody = Routes["api"]["whoisfaker"]["ws"]["subscribe"]["body"];
type SongBody = Routes["api"]["songuessr"]["ws"]["subscribe"]["body"];
type CEEBody = Routes["api"]["cee"]["ws"]["subscribe"]["body"];
/**
 * 旧路径不声明出站 `response` 模式：出站口径与统一入口一致，帧只经 `Packets` 工厂构造，
 * 框架不再对每一帧做全量结构校验。路由类型里只剩框架自带的 422 校验错误；有人重新挂上
 * `response` 时这里会编译失败，必须连同出站口径的用例一起重新决定。
 */
type FakerResponses = Routes["api"]["whoisfaker"]["ws"]["subscribe"]["response"];
type SongResponses = Routes["api"]["songuessr"]["ws"]["subscribe"]["response"];
type CEEResponses = Routes["api"]["cee"]["ws"]["subscribe"]["response"];
export type NoOutboundSchema = Assert<
  [keyof FakerResponses | keyof SongResponses | keyof CEEResponses] extends [422] ? true : false
>;
type Ready = Routes["readyz"]["get"]["response"];
export type ReadySuccess = Assert<Ready[200]["ready"] extends true ? true : false>;
export type ReadyFailure = Assert<Ready[503]["ready"] extends false ? true : false>;
export type ReadyFailureReason = Assert<
  Ready[503]["status"] extends "shutting_down" ? true : false
>;
export type NotAny = Assert<IsAny<FakerBody | SongBody | CEEBody> extends false ? true : false>;
export type NotNever = Assert<
  IsNever<FakerBody> | IsNever<SongBody> | IsNever<CEEBody> extends false ? true : false
>;
const faker: FakerBody = {
  id: "compile",
  type: "game.submitDescription",
  payload: { text: "描述" },
};
const song: SongBody = { id: "compile", type: "song.auth.qr.check", payload: { key: "key" } };
const cee: CEEBody = { id: "compile", type: "cee.game.guess", payload: { characterId: 1 } };
// @ts-expect-error 卧底描述必须为文本。
const wrongFaker: FakerBody = {
  id: "compile",
  type: "game.submitDescription",
  payload: { text: 1 },
};
// @ts-expect-error 扫码 key 必须为字符串。
const wrongSong: SongBody = { id: "compile", type: "song.auth.qr.check", payload: { key: false } };
// @ts-expect-error CEE 角色标识是数字。
const wrongCEE: CEEBody = {
  id: "compile",
  type: "cee.game.guess",
  payload: { characterId: "not-a-number" },
};
// @ts-expect-error 未声明命令不得进入输入联合。
const unknown: FakerBody = { id: "compile", type: "unknown.command", payload: {} };
void [faker, song, cee, wrongFaker, wrongSong, wrongCEE, unknown];

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
