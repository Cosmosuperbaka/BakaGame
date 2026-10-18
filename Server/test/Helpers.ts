import type { GameRecorder } from "../src/domain/GameRecord";
import { WhoIsFakerService } from "../src/application/WhoIsFakerService";
import { EventLogger } from "../src/infrastructure/EventLogger";
import type { ConnectionRecord } from "../src/domain/Model";
import type { WhoIsFakerClientMessage } from "../src/shared/Index";

export interface TestConnection {
  record: ConnectionRecord;
  sent: unknown[];
  closed: Array<{ code?: number; reason?: string }>;
}

// 为每条测试创建独立的服务实例和可控时钟，避免用例互相污染。
export const createTestContext = (options: { gameRecorder?: GameRecorder } = {}) => {
  let currentTime = Date.UTC(2026, 3, 10, 0, 0, 0);
  const service = new WhoIsFakerService({
    gameRecorder: options.gameRecorder,
    now: () => currentTime,
    random: {
      nextInt: (maxExclusive: number) => Math.max(maxExclusive - 1, 0),
    },
    eventLogger: new EventLogger(),
  });

  return {
    service,
    advanceTime: (milliseconds: number) => {
      currentTime += milliseconds;
    },
    setTime: (value: number) => {
      currentTime = value;
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
