import { describe, expect, it, vi } from "vitest";
import { generateUuid, WebSocketClient } from "./WebsocketClient";

describe("WebSocketClient", () => {
  it("在非安全上下文（crypto.randomUUID 不存在）时平滑降级生成合法 UUID", () => {
    const originalRandomUuid = globalThis.crypto?.randomUUID;
    try {
      // @ts-expect-error 模拟非安全上下文缺少 randomUUID
      globalThis.crypto.randomUUID = undefined;
      const uuid = generateUuid();
      expect(uuid).toMatch(
        /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
      );
    } finally {
      if (originalRandomUuid) {
        globalThis.crypto.randomUUID = originalRandomUuid;
      }
    }
  });

  it("在安全上下文中优先使用原生 crypto.randomUUID", () => {
    const uuid = generateUuid();
    expect(uuid).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
    );
  });

  it("正确去除服务器地址末尾斜杠，避免双斜杠路径", () => {
    let createdWsUrl = "";
    class MockWebSocket {
      static OPEN = 1;
      static CONNECTING = 0;
      readyState = MockWebSocket.CONNECTING;
      constructor(url: string) {
        createdWsUrl = url;
      }
      close() {}
      send() {}
    }
    vi.stubGlobal("WebSocket", MockWebSocket);

    const client = new WebSocketClient("/api/whoisfaker/ws");
    client.connect();

    expect(createdWsUrl).not.toContain("//api");
    expect(createdWsUrl).toMatch(/\/api\/whoisfaker\/ws$/);

    vi.unstubAllGlobals();
  });
});
