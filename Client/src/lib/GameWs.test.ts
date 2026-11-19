import { describe, expect, it, vi } from "vitest";
import type { WhoIsFakerRoomEnterAck } from "@bakagame/shared";
import { createGameWs, type GameSend, type GameSendCommand } from "@/lib/GameWs";
import type { SendOptions, WebSocketClient } from "@/lib/WebsocketClient";
import type { CEECommandMap } from "@/lib/CEEWs";
import type { SonGuessrCommandMap } from "@/lib/SonGuessrWs";
import type { WhoIsFakerCommandMap } from "@/lib/WhoIsFakerWs";

/** 每个成员都读 `this`：门面把方法摘下来当普通函数转发就会丢掉客户端实例。 */
class RecordingClient {
  readonly calls: string[] = [];
  readonly handlers: unknown[] = [];

  connect() {
    this.calls.push("connect");
  }

  disconnect() {
    this.calls.push("disconnect");
  }

  waitForConnection(timeoutMs?: number) {
    this.calls.push(`waitForConnection:${timeoutMs}`);
    return Promise.resolve();
  }

  send(type: string, payload: Record<string, unknown>, options?: SendOptions) {
    return Promise.resolve({ type, payload, options });
  }

  onMessage(handler: Parameters<WebSocketClient["onMessage"]>[0]) {
    this.handlers.push(handler);
    return () => this.calls.push("unsubscribeMessage");
  }

  onStatus(handler: Parameters<WebSocketClient["onStatus"]>[0]) {
    this.handlers.push(handler);
    return () => this.calls.push("unsubscribeStatus");
  }
}

const clientOf = (client: RecordingClient) => client as unknown as WebSocketClient;

describe("门面工厂", () => {
  it("六个成员都转发给同一个客户端，订阅与退订留在客户端上", async () => {
    const client = new RecordingClient();
    const ws = createGameWs<WhoIsFakerCommandMap>(clientOf(client));

    ws.connect();
    ws.disconnect();
    await ws.waitForConnection(1_234);
    ws.onMessage(() => {})();
    ws.onStatus(() => {})();

    expect(client.calls).toEqual([
      "connect",
      "disconnect",
      "waitForConnection:1234",
      "unsubscribeMessage",
      "unsubscribeStatus",
    ]);
    expect(client.handlers).toHaveLength(2);
  });

  it("send 原样交出命令、载荷与发送选项", async () => {
    const client = new RecordingClient();
    const ws = createGameWs<SonGuessrCommandMap>(clientOf(client));

    await expect(
      ws.send("song.game.guess", { songId: "1" }, { roomId: "1234", timeout: 0 })
    ).resolves.toEqual({
      type: "song.game.guess",
      payload: { songId: "1" },
      options: { roomId: "1234", timeout: 0 },
    });
  });
});

describe("命令契约", () => {
  it("三款共享契约套进同一组签名，命令名与载荷写错在编译期失败", () => {
    // 直接断言成契约签名：`vi.fn<T>()` 会把泛型命令名塌成联合，探针就测不到逐条命令的约束。
    const fakerSend = vi.fn() as unknown as GameSend<WhoIsFakerCommandMap>;
    const songSend = vi.fn() as unknown as GameSendCommand<SonGuessrCommandMap>;
    const ceeSend = vi.fn() as unknown as GameSendCommand<CEECommandMap>;

    // ack 由命令推导：进房回包带会话令牌，不是任意对象。
    const enter: Promise<WhoIsFakerRoomEnterAck> = fakerSend("room.join", { userName: "玩家" });
    void enter;
    void songSend("song.game.guess", { songId: "1" }, { timeout: 0 });
    void ceeSend("cee.room.join", { userName: "玩家" });

    // @ts-expect-error 命令名不在卧底契约里
    void fakerSend("room.jion", { userName: "玩家" });
    // @ts-expect-error 载荷字段类型与契约不符
    void ceeSend("cee.room.join", { userName: 1 });

    expect(fakerSend).toHaveBeenCalledTimes(2);
    expect(songSend).toHaveBeenCalledWith("song.game.guess", { songId: "1" }, { timeout: 0 });
    expect(ceeSend).toHaveBeenCalledTimes(2);
  });
});
