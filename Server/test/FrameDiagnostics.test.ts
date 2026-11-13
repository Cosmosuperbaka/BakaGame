import { expect, spyOn, test } from "bun:test";
import { t, ValidationError } from "elysia";

import { AppError } from "../src/domain/Errors";
import type { EventLogger } from "../src/infrastructure/EventLogger";
import {
  decodeGameFrame,
  describeRawMessage,
  gameSocketError,
  salvageMessageIdentity,
} from "../src/transport/ws/FrameDiagnostics";

const fakeLogger = () => {
  const logger = { warn: () => {}, error: () => {} };
  const warn = spyOn(logger, "warn");
  const error = spyOn(logger, "error");
  return { logger: logger as unknown as EventLogger, warn, error };
};

test("帧诊断只给类型与大小，不复制内容与键名", () => {
  expect(describeRawMessage("secret-token")).toEqual({
    rawKind: "string",
    length: 12,
    sample: "[原始消息已省略]",
  });
  expect(describeRawMessage(42)).toEqual({ rawKind: "number" });
  expect(describeRawMessage(null)).toEqual({ rawKind: "object" });
  expect(describeRawMessage(new ArrayBuffer(8))).toEqual({ rawKind: "ArrayBuffer", byteLength: 8 });
  expect(describeRawMessage(new Uint8Array(3))).toEqual({ rawKind: "Uint8Array", byteLength: 3 });
  const described = describeRawMessage({ password: "x", token: "y" });
  expect(described).toEqual({ rawKind: "object", keyCount: 2 });
  expect(JSON.stringify(described)).not.toContain("password");
});

test("从校验失败的载荷抢救信封身份：字符串与对象都支持，字段截断", () => {
  expect(salvageMessageIdentity('{"id":"m-1","type":"join","traceId":"t-1"}')).toEqual({
    id: "m-1",
    type: "join",
    traceId: "t-1",
  });
  const long = salvageMessageIdentity({ id: "x".repeat(300), type: "y".repeat(100) });
  expect(long?.id.length).toBe(128);
  expect(long?.type?.length).toBe(64);
  expect(long).not.toHaveProperty("traceId");
});

test("拿不到可用 id 时不抢救", () => {
  expect(salvageMessageIdentity("not json")).toBeUndefined();
  expect(salvageMessageIdentity(null)).toBeUndefined();
  expect(salvageMessageIdentity({ id: 5 })).toBeUndefined();
  expect(salvageMessageIdentity({ id: "" })).toBeUndefined();
  expect(salvageMessageIdentity({ type: "join" })).toBeUndefined();
});

test("帧解码：带空白的 JSON 文本与二进制帧可解，其余与坏文本得到 undefined", () => {
  expect(decodeGameFrame(undefined, ' {"a":1} ')).toEqual({ a: 1 });
  expect(decodeGameFrame(undefined, new TextEncoder().encode('{"a":2}'))).toEqual({ a: 2 });
  expect(decodeGameFrame(undefined, "{broken")).toBeUndefined();
  expect(decodeGameFrame(undefined, 123)).toBeUndefined();
});

test("校验失败回错误包：带回抢救出的 id 与 traceId，日志只含大小信息", () => {
  const { logger, warn } = fakeLogger();
  const handler = gameSocketError(logger, "Demo", () => {
    throw new AppError("INVALID_MESSAGE", "字段不合法");
  });
  const value = { id: "m-9", traceId: "t-9", secret: "x" };
  const packet = handler({ error: new ValidationError("body", t.Object({ id: t.Number() }), value) });
  expect(packet).toMatchObject({
    type: "error",
    id: "m-9",
    traceId: "t-9",
    error: { code: "INVALID_MESSAGE", message: "字段不合法" },
  });
  expect(warn).toHaveBeenCalledTimes(1);
  expect(JSON.stringify(warn.mock.calls[0])).not.toContain("secret");
});

test("未知异常回 INTERNAL_ERROR 并记错误日志，id 缺失时用 unknown 占位", () => {
  const { logger, error } = fakeLogger();
  const packet = gameSocketError(logger, "Demo", () => undefined)({ error: new Error("boom") });
  expect(packet).toMatchObject({ id: "unknown", error: { code: "INTERNAL_ERROR" } });
  expect(error).toHaveBeenCalledTimes(1);
});
