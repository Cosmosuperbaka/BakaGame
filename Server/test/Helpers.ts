import type { GameRecorder } from "../src/domain/GameRecord";
import { WhoIsFakerService } from "../src/application/WhoIsFakerService";
import { EventLogger } from "../src/infrastructure/EventLogger";
import type { ConnectionRecord, WhoIsFakerClientMessage } from "../src/shared/Index";

export interface TestConnection {
  record: ConnectionRecord;
  sent: unknown[];
  closed: Array<{ code?: number; reason?: string }>;
}

// 为每条测试创建独立的服务实例和可控时钟，避免用例互相污染。
export const createTestContext = (options: { gameRecorder?: GameRecorder } = {}) => {
  let currentTime = Date.UTC(2026, 3, 10, 0, 0, 0);
  // 大厅合并窗的尾沿跟着注入时钟走：挂在真实定时器上的话，「窗口内不重复下发」这类断言
  // 取决于用例跑了多少墙钟时间，满载机器上会时好时坏。实现保证同一时刻至多一个尾沿。
  let pendingLobbyFlush: { at: number; flush: () => void } | undefined;
  const drainLobbyFlush = () => {
    if (!pendingLobbyFlush || pendingLobbyFlush.at > currentTime) return;
    const timer = pendingLobbyFlush;
    pendingLobbyFlush = undefined;
    timer.flush();
  };
  const service = new WhoIsFakerService({
    gameRecorder: options.gameRecorder,
    now: () => currentTime,
    random: {
      nextInt: (maxExclusive: number) => Math.max(maxExclusive - 1, 0),
    },
    eventLogger: new EventLogger(),
    lobbyFanoutSchedule: (flush, delayMs) => {
      pendingLobbyFlush = { at: currentTime + delayMs, flush };
    },
  });

  return {
    service,
    advanceTime: (milliseconds: number) => {
      currentTime += milliseconds;
      drainLobbyFlush();
    },
    setTime: (value: number) => {
      currentTime = value;
      drainLobbyFlush();
    },
  };
};

// 测试连接只保留最小能力：收消息和记录 close 调用。
export const createConnection = (service: WhoIsFakerService, id: string): TestConnection => {
  const sent: unknown[] = [];
  const closed: Array<{ code?: number; reason?: string }> = [];
  const record: ConnectionRecord = {
    id,
    lobbySubscribed: false,
    send: (payload) => {
      sent.push(payload);
    },
    close: (code?: number, reason?: string) => {
      closed.push({ code, reason });
    },
  };

  service.registerConnection(record);

  return {
    record,
    sent,
    closed,
  };
};

// 测试里直接复用生产 execute 入口，尽量走真实业务路径。
export const execute = async (
  service: WhoIsFakerService,
  connection: TestConnection,
  message: WhoIsFakerClientMessage
) => service.execute(connection.record.id, message);

// 从测试连接里筛出某一类事件，便于断言广播结果。
export const getEventPayloads = <TPayload>(connection: TestConnection, event: string): TPayload[] =>
  connection.sent
    .filter(
      (entry): entry is { type: "event"; event: string; payload: TPayload } =>
        Boolean(entry) &&
        typeof entry === "object" &&
        (entry as { type?: string }).type === "event" &&
        (entry as { event?: string }).event === event
    )
    .map((entry) => entry.payload);

export const getLastEventPayload = <TPayload>(
  connection: TestConnection,
  event: string
): TPayload | undefined => {
  const payloads = getEventPayloads<TPayload>(connection, event);
  return payloads.at(-1);
};
