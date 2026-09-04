import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

class MockWebSocket {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static instances: MockWebSocket[] = [];

  readonly url: string;
  readyState = MockWebSocket.CONNECTING;
  sent: string[] = [];
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: string }) => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;

  constructor(url: string) {
    this.url = url;
    MockWebSocket.instances.push(this);
  }

  send(payload: string) {
    this.sent.push(payload);
  }

  open() {
    this.readyState = MockWebSocket.OPEN;
    this.onopen?.();
  }

  receive(payload: unknown) {
    this.onmessage?.({ data: JSON.stringify(payload) });
  }

  close() {
    this.readyState = 3;
    this.onclose?.();
  }
}

describe("websocket client", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.resetModules();
    MockWebSocket.instances = [];
    vi.stubGlobal("WebSocket", MockWebSocket);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("sends the typed envelope and resolves the matching acknowledgement", async () => {
    const socketApi = await import("./WhoIsFakerWs");
    socketApi.connect();
    const socket = MockWebSocket.instances[0];
    socket.open();

    const pending = socketApi.send<{ accepted: boolean }>(
      "room.join",
      { userName: "玩家" },
      { roomId: "1234", sessionToken: "token" },
    );
    const envelope = JSON.parse(socket.sent[0]) as { id: string };
    socket.receive({
      type: "ack",
      id: envelope.id,
      requestType: "room.join",
      payload: { accepted: true },
    });

    await expect(pending).resolves.toEqual({ accepted: true });
    expect(JSON.parse(socket.sent[0])).toMatchObject({
      type: "room.join",
      roomId: "1234",
      sessionToken: "token",
      payload: { userName: "玩家" },
    });
  });

  it("rejects pending requests immediately when the connection closes", async () => {
    const socketApi = await import("./WhoIsFakerWs");
    socketApi.connect();
    const socket = MockWebSocket.instances[0];
    socket.open();

    const rejection = expect(socketApi.send("chat.send", { text: "hi" })).rejects.toMatchObject({
      code: "DISCONNECTED",
    });
    socket.close();

    await rejection;
  });

  it("notifies status listeners and reconnects with exponential backoff", async () => {
    const socketApi = await import("./WhoIsFakerWs");
    const statuses: boolean[] = [];
    socketApi.onStatus((connected) => statuses.push(connected));
    socketApi.connect();

    MockWebSocket.instances[0].open();
    MockWebSocket.instances[0].close();
    expect(statuses).toEqual([true, false]);

    await vi.advanceTimersByTimeAsync(999);
    expect(MockWebSocket.instances).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(MockWebSocket.instances).toHaveLength(2);
  });

  it("immediately informs a status listener when the shared socket is already open", async () => {
    const socketApi = await import("./WhoIsFakerWs");
    socketApi.connect();
    MockWebSocket.instances[0].open();

    const statuses: boolean[] = [];
    socketApi.onStatus((connected) => statuses.push(connected));

    expect(statuses).toEqual([true]);
  });
});
