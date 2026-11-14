import { Scope } from "@sentry/bun";
import type * as Sentry from "@sentry/bun";

/**
 * 错误上报桩工厂：Scope 是带保护字段的类，半截对象字面量满足不了它，
 * 用真实构造再覆写用例要断言的方法；withScope 按 SDK 的两个重载如实转发回调。
 * 这样返回值如实满足被桩类型，接口增删方法时编译器会报，而不是被 as any 吞掉。
 */
export const fakeSentryScope = (
  overrides: Partial<Pick<Scope, "setTag" | "setExtras">> = {}
): Scope => Object.assign(new Scope(), overrides);

export const fakeWithScope =
  (scope: Scope): typeof Sentry.withScope =>
  <T>(arg1: Scope | undefined | ((scope: Scope) => T), arg2?: (scope: Scope) => T): T => {
    const callback = typeof arg1 === "function" ? arg1 : arg2;
    if (!callback) throw new Error("fakeWithScope: 缺少回调");
    return callback(scope);
  };
