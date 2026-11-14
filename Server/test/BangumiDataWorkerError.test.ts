import { describe, expect, test } from "bun:test";
import {
  toErrorContext,
  type BangumiErrorContext,
} from "../src/infrastructure/BangumiDataWorkerError";

/** 顺着 cause 链收集每一层的 message，用来断言递归限深。 */
const causeMessages = (context: BangumiErrorContext): string[] => {
  const messages: string[] = [];
  let current: BangumiErrorContext | undefined = context;
  while (current) {
    messages.push(current.message);
    current = current.cause;
  }
  return messages;
};

describe("Worker 错误上下文摊平", () => {
  test("Error 的 name、message、stack 原样保留", () => {
    const error = new Error("查询失败");
    error.name = "CustomError";
    const context = toErrorContext(error);
    expect(context.name).toBe("CustomError");
    expect(context.message).toBe("查询失败");
    expect(context.stack).toBe(error.stack);
    expect(context.cause).toBeUndefined();
  });

  test("没有 stack 的 Error 不写 stack 字段", () => {
    const error = new Error("无栈");
    delete error.stack;
    const context = toErrorContext(error);
    expect(context.message).toBe("无栈");
    expect("stack" in context).toBe(false);
  });

  test("非 Error 抛出值记 NonErrorThrown，取值本身不再抛", () => {
    expect(toErrorContext("boom")).toMatchObject({ name: "NonErrorThrown", message: "boom" });
    expect(toErrorContext(Symbol("x")).message).toBe("Symbol(x)");
    expect(toErrorContext(10n).message).toBe("10");
    expect(toErrorContext({ a: 1 }).message).toBe('{"a":1}');
    expect(toErrorContext(undefined).message).toBe("undefined");
    expect(toErrorContext(null).message).toBe("null");
  });

  test("循环对象序列化失败时退回 String，不让日志再抛一次", () => {
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    const context = toErrorContext(circular);
    expect(context.name).toBe("NonErrorThrown");
    expect(context.message).toBe("[object Object]");
  });

  test("cause 链按层递归，最多到三层就截断", () => {
    const deepest = new Error("第四层");
    const third = new Error("第三层", { cause: deepest });
    const second = new Error("第二层", { cause: third });
    const first = new Error("第一层", { cause: second });
    const top = new Error("顶层", { cause: first });

    const context = toErrorContext(top);
    // 顶层 + 三层 cause 共四节点；第四层（deepest）被限深丢掉。
    expect(causeMessages(context)).toEqual(["顶层", "第一层", "第二层", "第三层"]);
    expect(JSON.stringify(context)).not.toContain("第四层");
  });

  test("cause 是非 Error 值时同样摊平为 NonErrorThrown", () => {
    const error = new Error("外层", { cause: "内层字符串" });
    const context = toErrorContext(error);
    expect(context.cause).toMatchObject({ name: "NonErrorThrown", message: "内层字符串" });
  });
});
