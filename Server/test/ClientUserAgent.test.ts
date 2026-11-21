import { describe, expect, test } from "bun:test";
import {
  CLIENT_UA_UNKNOWN,
  clientUaToken,
  formatClientUserAgent,
  formatGameVersion,
  gameVersionFromManifest,
  parseClientUserAgent,
  type ClientUserAgent,
} from "../src/shared/ClientUserAgent";

const desktop: ClientUserAgent = {
  clientVersion: "0.2.1",
  osName: "Windows",
  osVersion: "10.0.26100",
  arch: "x64",
  clientType: "desktop",
  gameVersion: "2.0.3+eb11009",
};

describe("客户端 User-Agent 段", () => {
  test("按约定格式拼出三端的示例", () => {
    expect(formatClientUserAgent(desktop)).toBe(
      "BakaGame/0.2.1 (Windows 10.0.26100; x64; desktop) Game/2.0.3+eb11009"
    );
    expect(
      formatClientUserAgent({ ...desktop, osName: "macOS", osVersion: "15.1", arch: "arm64" })
    ).toBe("BakaGame/0.2.1 (macOS 15.1; arm64; desktop) Game/2.0.3+eb11009");
    expect(
      formatClientUserAgent({
        clientVersion: "0.1.6",
        osName: "Android",
        osVersion: "15",
        arch: "arm64-v8a",
        clientType: "mobile",
        gameVersion: "2.0.3+eb11009",
      })
    ).toBe("BakaGame/0.1.6 (Android 15; arm64-v8a; mobile) Game/2.0.3+eb11009");
  });

  test("取不到的截写 unknown，整体形状不变；括号、分号与空白不会打乱段结构", () => {
    const ua = formatClientUserAgent({
      ...desktop,
      osVersion: "",
      arch: "x(64); evil",
      gameVersion: CLIENT_UA_UNKNOWN,
    });
    expect(ua).toBe("BakaGame/0.2.1 (Windows unknown; x64evil; desktop) Game/unknown");
    expect(parseClientUserAgent(ua)).toEqual({
      ...desktop,
      osVersion: "unknown",
      arch: "x64evil",
      gameVersion: "unknown",
    });
    expect(clientUaToken(" 1.2 3 ")).toBe("1.23");
    expect(clientUaToken(null)).toBe("unknown");
  });

  test("从 WebView 的完整 UA 里取出追加在后面的客户端段", () => {
    const webview =
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) " +
      "Chrome/142.0.0.0 Safari/537.36 Edg/142.0.0.0 " +
      formatClientUserAgent(desktop);
    expect(parseClientUserAgent(webview)).toEqual(desktop);
    // 原生请求只有这一段
    expect(parseClientUserAgent(formatClientUserAgent(desktop))).toEqual(desktop);
  });

  test("网页、词表外的系统名或客户端类型、残缺的段都不算客户端", () => {
    expect(parseClientUserAgent(undefined)).toBeNull();
    expect(parseClientUserAgent("Mozilla/5.0 (X11; Linux x86_64)")).toBeNull();
    expect(
      parseClientUserAgent("BakaGame/0.2.1 (Linux 6.1; x64; desktop) Game/2.0.3+eb11009")
    ).toBeNull();
    expect(
      parseClientUserAgent("BakaGame/0.2.1 (Windows 10.0; x64; web) Game/2.0.3+eb11009")
    ).toBeNull();
    expect(parseClientUserAgent("BakaGame/0.2.1 (Windows 10.0; x64; desktop)")).toBeNull();
    expect(
      parseClientUserAgent("NotBakaGame/0.2.1 (Windows 10.0; x64; desktop) Game/1.0.0")
    ).toBeNull();
  });

  test("游戏版本：产品版本加短提交号，提交号取不到只写版本，版本取不到为 unknown", () => {
    expect(formatGameVersion("2.0.3", "eb11009")).toBe("2.0.3+eb11009");
    expect(formatGameVersion("2.0.3", "EB11009")).toBe("2.0.3+eb11009");
    expect(formatGameVersion("2.0.3", "dev")).toBe("2.0.3");
    expect(formatGameVersion("2.0.3", "")).toBe("2.0.3");
    expect(formatGameVersion("", "eb11009")).toBe("unknown");
    expect(formatGameVersion("v2.0", "eb11009")).toBe("unknown");
    expect(formatGameVersion(undefined, undefined)).toBe("unknown");
  });

  test("版本清单：形状对就取游戏版本，不对一律 unknown", () => {
    expect(gameVersionFromManifest({ version: "2.0.3", commit: "eb11009" })).toBe("2.0.3+eb11009");
    expect(gameVersionFromManifest({ version: 2, commit: "eb11009" })).toBe("unknown");
    expect(gameVersionFromManifest(null)).toBe("unknown");
    expect(gameVersionFromManifest("2.0.3")).toBe("unknown");
  });
});
