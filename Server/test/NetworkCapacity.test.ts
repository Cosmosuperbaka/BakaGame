import { expect, test } from "bun:test";

import type { ConnectionRecord } from "../src/shared/Index";
import { createAck } from "../src/transport/Packets";
import { StateSyncEncoder } from "../src/transport/StateSync";
import { createTestContext, execute, type TestConnection } from "./Helpers";
import { ccbTestHarness } from "./CCBNativeFixtures";

const TARGET_PLAYERS = 150;
const MUTATIONS_PER_SECOND = 12;
const TEST_DURATION_SECONDS = 60;
const TARGET_BITS_PER_SECOND = 6_000_000;
const TRANSPORT_OVERHEAD_RATIO = 1.15;
const ROOM_ID = "6150";

const utf8Bytes = (value: unknown) => Buffer.byteLength(JSON.stringify(value), "utf8");

const websocketFrameBytes = (payloadBytes: number) =>
  payloadBytes + (payloadBytes < 126 ? 2 : payloadBytes < 65_536 ? 4 : 10);

test("6Mbps 可以承载 150 人 WhoIsFaker 的高频状态同步", async () => {
  const { service, advanceTime } = createTestContext();
  let networkNow = 0;
  let measuredBytes = 0;

  const createMeasuredConnection = (id: string): TestConnection => {
    const encoder = new StateSyncEncoder({ now: () => networkNow });
    const record: ConnectionRecord = {
      id,
      lobbySubscribed: false,
      send(payload) {
        for (const packet of encoder.encode(payload)) {
          measuredBytes += websocketFrameBytes(utf8Bytes(packet));
        }
      },
      resetStateSync: () => encoder.reset(),
      sendStateSyncCalibration(payload) {
        for (const packet of encoder.encode(payload, { calibration: true })) {
          measuredBytes += websocketFrameBytes(utf8Bytes(packet));
        }
      },
      close: () => {},
    };
    service.registerConnection(record);
    return { record, sent: [], closed: [] };
  };

  const players: TestConnection[] = [createMeasuredConnection("capacity-host")];
  await execute(service, players[0], {
    id: "create-capacity-room",
    type: "room.create",
    payload: {
      roomId: ROOM_ID,
      name: "150人承载测试房间",
      visibility: "public",
      allowSpectators: true,
      userName: "玩家0",
    },
  });

  for (let index = 1; index < TARGET_PLAYERS; index += 1) {
    const connection = createMeasuredConnection(`capacity-${index}`);
    players.push(connection);
    await execute(service, connection, {
      id: `join-${index}`,
      type: "room.join",
      roomId: ROOM_ID,
      payload: { userName: `玩家${index}` },
    });
  }

  // 建房与加入属于一次性冷启动流量，不计入满房游玩时的持续带宽。
  measuredBytes = 0;
  const mutationCount = MUTATIONS_PER_SECOND * TEST_DURATION_SECONDS;
  for (let mutation = 0; mutation < mutationCount; mutation += 1) {
    const connection = players[mutation % players.length];
    const ready = Math.floor(mutation / players.length) % 2 === 0;
    const message = {
      id: `ready-${mutation}`,
      type: "player.setReady" as const,
      roomId: ROOM_ID,
      payload: { ready },
    };
    await execute(service, connection, message);

    // 请求与 ack 也占用线路；状态广播由连接的生产编码器直接计量。
    measuredBytes += websocketFrameBytes(utf8Bytes(message));
    measuredBytes += websocketFrameBytes(utf8Bytes(createAck(message, { ready })));
    const elapsedMs = 1_000 / MUTATIONS_PER_SECOND;
    networkNow += elapsedMs;
    advanceTime(elapsedMs);
  }

  // 真实 housekeeping 每 10 秒检查一次；第 60 秒必须计入无变化也会发送的全量校准。
  await service.runHousekeeping();

  const bitsPerSecond =
    measuredBytes * TRANSPORT_OVERHEAD_RATIO * 8 / TEST_DURATION_SECONDS;
  console.info(`150 人真实房间容量估算: ${(bitsPerSecond / 1_000_000).toFixed(2)} Mbps`);
  expect(bitsPerSecond).toBeLessThanOrEqual(TARGET_BITS_PER_SECOND);
}, 30_000);

test("6Mbps 可以承载 150 人 CCB 的高频状态与私有猜测同步", async () => {
  const h = ccbTestHarness();
  let networkNow = 0, measuredBytes = 0, patchCount = 0, fullCount = 0;
  const meter = (client: ReturnType<typeof h.connect>) => {
    const encoder = new StateSyncEncoder({ now: () => networkNow });
    const count = (payload: unknown, calibration = false) => {
      for (const packet of encoder.encode(payload, { calibration })) {
        measuredBytes += websocketFrameBytes(utf8Bytes(packet));
        const sync = (packet as { payload?: { mode?: string } }).payload;
        if (sync?.mode === 'patch') patchCount++;
        if (sync?.mode === 'full') fullCount++;
      }
    };
    client.record.send = payload => count(payload);
    client.record.resetStateSync = () => encoder.reset();
    client.record.sendStateSyncCalibration = payload => count(payload, true);
  };
  try {
    const host = h.connect('容量房主'); meter(host);
    await h.send(host, 'ccb.room.create', { source: 'native', roomId: '1234', name: '容量测试', userName: '玩家0', visibility: 'public', allowSpectators: true });
    const players = [host];
    for (let index = 1; index < TARGET_PLAYERS; index++) {
      const player = h.connect(`玩家${index}`); meter(player); players.push(player);
      await h.send(player, 'ccb.room.join', { source: 'native', userName: `玩家${index}` });
    }
    await h.configure(host, { nonstopMode: true, maxAttempts: 100 });
    await h.ready(...players.slice(1)); await h.send(host, 'ccb.game.start', {});
    measuredBytes = 0; patchCount = 0; fullCount = 0;
    for (let mutation = 0; mutation < MUTATIONS_PER_SECOND * TEST_DURATION_SECONDS; mutation++) {
      const player = players[mutation % players.length];
      const message = { id: `ccb-capacity-${mutation}`, type: 'ccb.game.guess' as const, roomId: '1234', sessionToken: player.token, payload: { characterId: mutation % 2 ? 3 : 4 } };
      const result = await h.service.execute(player.record.id, message);
      measuredBytes += websocketFrameBytes(utf8Bytes(message)) + websocketFrameBytes(utf8Bytes(createAck(message, result)));
      networkNow += 1000 / MUTATIONS_PER_SECOND;
    }
    // 两条生产状态通道在60秒处均须全量校准，无变更的私有通道也不得缺失。
    networkNow = 60_001; h.service.runHousekeeping();
    const bitsPerSecond = measuredBytes * TRANSPORT_OVERHEAD_RATIO * 8 / TEST_DURATION_SECONDS;
    console.info(`150 人 CCB 猜测容量估算: ${(bitsPerSecond / 1_000_000).toFixed(2)} Mbps`);
    expect(patchCount).toBeGreaterThan(0);
    expect(fullCount).toBeGreaterThanOrEqual(TARGET_PLAYERS);
    expect(bitsPerSecond).toBeLessThanOrEqual(TARGET_BITS_PER_SECOND);
  } finally { h.service.close(); }
}, 30_000);
