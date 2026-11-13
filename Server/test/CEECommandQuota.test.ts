import { afterEach, expect, test } from "bun:test";
import { CEEOriginalService } from "../src/application/CEEOriginalService";
import { CEEService } from "../src/application/CEEService";
import {
  COMMAND_RATE_LIMIT_PER_CONNECTION,
  COMMAND_RATE_LIMIT_WINDOW_MS,
} from "../src/config/Constants";
import type { ConnectionRecord } from "../src/shared/Index";
import { FixtureRoom, originalData } from "./CEEOriginalFixtures";

// 猜猜呗的每连接命令总额度与另外两款共用同一组常量：改一处，三款一起变。

const services: CEEService[] = [];
afterEach(async () => {
  for (const service of services.splice(0)) await service.close();
});

test("满额度放行、多一条回 RATE_LIMITED、窗口过后恢复；额度按连接计", async () => {
  let clock = 1_000_000;
  const upstream = new FixtureRoom();
  const original = new CEEOriginalService({
    data: originalData,
    serverUrl: "https://quota.invalid",
    aesSecret: "quota-key",
    socketFactory: upstream.factory,
    fetcher: async () => Response.json([]),
  });
  const service = new CEEService({
    data: originalData,
    originalService: original,
    now: () => clock,
  });
  services.push(service);
  const connect = (id: string) => {
    const record: ConnectionRecord = { id, lobbySubscribed: false, send() {}, close() {} };
    service.registerConnection(record);
    return record.id;
  };
  const run = (id: string) =>
    service.execute(id, {
      id: crypto.randomUUID(),
      type: "cee.lobby.subscribeRooms",
      payload: {},
    } as never);
  const first = connect("quota-first");
  const second = connect("quota-second");

  for (let index = 0; index < COMMAND_RATE_LIMIT_PER_CONNECTION; index += 1)
    await expect(run(first)).resolves.toBeDefined();
  await expect(run(first)).rejects.toMatchObject({ code: "RATE_LIMITED" });
  await expect(run(second)).resolves.toBeDefined();

  clock += COMMAND_RATE_LIMIT_WINDOW_MS + 1;
  await expect(run(first)).resolves.toBeDefined();
});
