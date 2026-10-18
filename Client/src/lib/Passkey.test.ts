import { describe, expect, it, vi } from "vitest";
import { AuthRequestError } from "./Api";

// 端点调用与系统弹窗各换一个桩：这里只验「先取选项、再让浏览器做 ceremony、最后回传响应」的编排。
const authGet = vi.hoisted(() => vi.fn<(path: string) => Promise<unknown>>());
const authPost = vi.hoisted(() =>
  vi.fn<(path: string, body: Record<string, unknown>) => Promise<void>>()
);

vi.mock("./Api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./Api")>()),
  authGet,
  authPost,
}));

const browserSupportsWebAuthn = vi.hoisted(() => vi.fn<() => boolean>());
const startAuthentication = vi.hoisted(() =>
  vi.fn<(input: { optionsJSON: unknown }) => Promise<string>>()
);
const startRegistration = vi.hoisted(() =>
  vi.fn<(input: { optionsJSON: unknown }) => Promise<string>>()
);

vi.mock("@simplewebauthn/browser", () => ({
  browserSupportsWebAuthn,
  startAuthentication,
  startRegistration,
}));

import {
  addPasskey,
  listPasskeys,
  passkeyErrorMessage,
  passkeySupported,
  removePasskey,
  signInWithPasskey,
} from "./Passkey";

describe("通行密钥客户端", () => {
  it("能力探测直接读 WebAuthn 是否可用", () => {
    browserSupportsWebAuthn.mockReturnValue(true);
    expect(passkeySupported()).toBe(true);
    browserSupportsWebAuthn.mockReturnValue(false);
    expect(passkeySupported()).toBe(false);
  });

  it("登录：取认证选项交给浏览器，再把响应回传给校验端点", async () => {
    const optionsJSON = { challenge: "c1", rpId: "game.example.com" };
    authGet.mockResolvedValue(optionsJSON);
    startAuthentication.mockResolvedValue("assertion");

    await signInWithPasskey();

    expect(authGet).toHaveBeenCalledWith("/passkey/generate-authenticate-options");
    expect(startAuthentication).toHaveBeenCalledWith({ optionsJSON });
    expect(authPost).toHaveBeenCalledWith("/passkey/verify-authentication", {
      response: "assertion",
    });
  });

  it("添加：取注册选项交给浏览器，再把响应回传给落库端点", async () => {
    const optionsJSON = { challenge: "c2", rp: { id: "game.example.com" } };
    authGet.mockResolvedValue(optionsJSON);
    startRegistration.mockResolvedValue("attestation");

    await addPasskey();

    expect(authGet).toHaveBeenCalledWith("/passkey/generate-register-options");
    expect(startRegistration).toHaveBeenCalledWith({ optionsJSON });
    expect(authPost).toHaveBeenCalledWith("/passkey/verify-registration", {
      response: "attestation",
    });
  });

  it("列表与移除只走服务端开放的端点", async () => {
    authGet.mockResolvedValue([]);
    await expect(listPasskeys()).resolves.toEqual([]);
    expect(authGet).toHaveBeenCalledWith("/passkey/list-user-passkeys");

    authPost.mockResolvedValue();
    await removePasskey("pk-1");
    expect(authPost).toHaveBeenCalledWith("/passkey/delete-passkey", { id: "pk-1" });
  });

  it("浏览器取消记作用户意愿，不报成密钥坏了", () => {
    for (const name of ["NotAllowedError", "AbortError"]) {
      expect(passkeyErrorMessage(new DOMException("x", name), "兜底")).toBe("已取消通行密钥验证");
    }
  });

  it("服务端中文原因原样透出，其余错误只给兜底文案", () => {
    expect(
      passkeyErrorMessage(
        new AuthRequestError("SESSION_NOT_FRESH", "这次登录已超过一天", 403),
        "兜底"
      )
    ).toBe("这次登录已超过一天");
    expect(passkeyErrorMessage(new Error("boom"), "通行密钥添加失败，请稍后重试")).toBe(
      "通行密钥添加失败，请稍后重试"
    );
  });
});
