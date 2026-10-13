import { afterEach, describe, expect, it, vi } from "vitest";
import { ORPCError } from "@orpc/client";

import { apiErrorMessage, AuthRequestError, createApiClient, isAccountDisabled, signInWithCode } from "./Api";

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("账号 API 客户端", () => {
  it("带凭据请求 /api/rpc，并按 oRPC 线格式解出结果", async () => {
    const fetchMock = vi.fn(async (request: Request, init?: RequestInit) => {
      expect(new URL(request.url).pathname).toBe("/api/rpc/account/me");
      expect(init?.credentials).toBe("include");
      return json(200, { json: null });
    });
    vi.stubGlobal("fetch", fetchMock);
    await expect(createApiClient().account.me()).resolves.toBeNull();
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it("识别服务端的 ACCOUNT_DISABLED，与网关自身的 503 区分", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => json(503, { json: { defined: false, code: "ACCOUNT_DISABLED", status: 503, message: "账号系统未启用" } })));
    const disabled = await createApiClient().account.me().catch((error: unknown) => error);
    expect(isAccountDisabled(disabled)).toBe(true);

    vi.stubGlobal("fetch", vi.fn(async () => new Response("<html>bad gateway</html>", { status: 503 })));
    const gateway = await createApiClient().account.me().catch((error: unknown) => error);
    expect(isAccountDisabled(gateway)).toBe(false);
    expect(apiErrorMessage(gateway)).toBe("请求失败，请稍后重试");
  });

  it("只展示中文错误文案，英文与校验失败退回兜底或首条中文问题", () => {
    expect(apiErrorMessage(new ORPCError("RATE_LIMITED", { message: "操作太频繁，请稍后再试" }))).toBe("操作太频繁，请稍后再试");
    expect(apiErrorMessage(new ORPCError("INTERNAL_SERVER_ERROR", { message: "Internal server error" }), "兜底")).toBe("兜底");
    expect(apiErrorMessage(new ORPCError("BAD_REQUEST", { message: "Input validation failed", data: { issues: [{ message: "QQ 号格式不正确" }] } }))).toBe("QQ 号格式不正确");
    expect(apiErrorMessage(new TypeError("Failed to fetch"))).toBe("请求失败，请稍后重试");
  });

  it("验证码登录：请求只带邮箱与验证码，Better Auth 的英文错误码映射成中文", async () => {
    const fetchMock = vi.fn(async (_url: URL, init?: RequestInit) => {
      expect(JSON.parse(String(init?.body))).toEqual({ email: "10001@qq.com", otp: "123456" });
      return json(400, { code: "INVALID_OTP", message: "Invalid OTP" });
    });
    vi.stubGlobal("fetch", fetchMock);
    const error = await signInWithCode({ email: "10001@qq.com", otp: "123456" }).catch((cause: unknown) => cause);
    expect(error).toBeInstanceOf(AuthRequestError);
    expect(error).toMatchObject({ code: "INVALID_OTP", message: "验证码不正确", status: 400 });
    expect(String(fetchMock.mock.calls[0]?.[0])).toMatch(/\/api\/auth\/sign-in\/email-otp$/);
  });

  it("网络中断时给出中文提示", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => {
      throw new TypeError("Failed to fetch");
    }));
    await expect(signInWithCode({ email: "10001@qq.com", otp: "123456" })).rejects.toMatchObject({ code: "NETWORK_ERROR", message: "网络异常，请稍后重试" });
  });
});
