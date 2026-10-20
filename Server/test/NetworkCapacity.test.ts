import { expect, test } from "bun:test";

import { ConnectionRegistry } from "../src/application/ConnectionRegistry";
import { LOBBY_MERGE_WINDOW_MS, LobbyFanout } from "../src/application/LobbyFanout";
import {
  WHOISFAKER_LOBBY_ROOMS_EVENT,
  WHOISFAKER_PHASES,
  type ConnectionRecord,
  type WhoIsFakerRoomSummary,
} from "../src/shared/Index";
import { createAck } from "../src/transport/Packets";
import { StateSyncEncoder } from "../src/transport/StateSync";
import { createTestContext, execute, type TestConnection } from "./Helpers";
import { ceeTestHarness, character } from "./CEENativeFixtures";

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

  const bitsPerSecond = (measuredBytes * TRANSPORT_OVERHEAD_RATIO * 8) / TEST_DURATION_SECONDS;
  console.info(`150 人真实房间容量估算: ${(bitsPerSecond / 1_000_000).toFixed(2)} Mbps`);
  expect(bitsPerSecond).toBeLessThanOrEqual(TARGET_BITS_PER_SECOND);
}, 30_000);

test("6Mbps 可以承载 150 人 CEE 的高频状态与私有猜测同步", async () => {
  // 原版2382份外部标签记录最多21项，容量预算覆盖该实际最大值。
  const withExtraTags = (id: number) => ({
    ...character(id),
    extraTags: Array.from({ length: 3 }, (_, section) => ({
      section: `标签分区${section}`,
      tags: Array.from({ length: 7 }, (_, tag) => `游戏角色属性${section}-${tag}`),
    })),
  });
  const h = ceeTestHarness({
    chooseRandomCharacter: async () => withExtraTags(1),
    getCharacter: async (id) => withExtraTags(id),
  });
  let networkNow = 0,
    measuredBytes = 0,
    patchCount = 0,
    fullCount = 0;
  const meter = (client: ReturnType<typeof h.connect>) => {
    const encoder = new StateSyncEncoder({ now: () => networkNow });
    const count = (payload: unknown, calibration = false) => {
      for (const packet of encoder.encode(payload, { calibration })) {
        measuredBytes += websocketFrameBytes(utf8Bytes(packet));
        const sync = (packet as { payload?: { mode?: string } }).payload;
        if (sync?.mode === "patch") patchCount++;
        if (sync?.mode === "full") fullCount++;
      }
    };
    client.record.send = (payload) => count(payload);
    client.record.resetStateSync = () => encoder.reset();
    client.record.sendStateSyncCalibration = (payload) => count(payload, true);
  };
  try {
    const host = h.connect("容量房主");
    meter(host);
    await h.send(host, "cee.room.create", {
      source: "native",
      roomId: "1234",
      name: "容量测试",
      userName: "玩家0",
      visibility: "public",
      allowSpectators: true,
    });
    const players = [host];
    for (let index = 1; index < TARGET_PLAYERS; index++) {
      const player = h.connect(`玩家${index}`);
      meter(player);
      players.push(player);
      await h.send(player, "cee.room.join", { userName: `玩家${index}` });
    }
    await h.configure(host, { nonstopMode: true, maxAttempts: 100 });
    await h.ready(...players.slice(1));
    await h.send(host, "cee.game.start", {});
    measuredBytes = 0;
    patchCount = 0;
    fullCount = 0;
    for (let mutation = 0; mutation < MUTATIONS_PER_SECOND * TEST_DURATION_SECONDS; mutation++) {
      const player = players[mutation % players.length];
      const message = {
        id: `cee-capacity-${mutation}`,
        type: "cee.game.guess" as const,
        roomId: "1234",
        sessionToken: player.token,
        payload: { characterId: mutation % 2 ? 3 : 4 },
      };
      const result = await h.service.execute(player.record.id, message);
      measuredBytes +=
        websocketFrameBytes(utf8Bytes(message)) +
        websocketFrameBytes(utf8Bytes(createAck(message, result)));
      networkNow += 1000 / MUTATIONS_PER_SECOND;
    }
    // 两条生产状态通道在60秒处均须全量校准，无变更的私有通道也不得缺失。
    networkNow = 60_001;
    h.service.runHousekeeping();
    const bitsPerSecond = (measuredBytes * TRANSPORT_OVERHEAD_RATIO * 8) / TEST_DURATION_SECONDS;
    console.info(`150 人 CEE 猜测容量估算: ${(bitsPerSecond / 1_000_000).toFixed(2)} Mbps`);
    expect(patchCount).toBeGreaterThan(0);
    expect(fullCount).toBeGreaterThanOrEqual(TARGET_PLAYERS);
    expect(bitsPerSecond).toBeLessThanOrEqual(TARGET_BITS_PER_SECOND);
  } finally {
    h.service.close();
  }
}, 30_000);

const LOBBY_SUBSCRIBERS = 200;
const LOBBY_ROOM_COUNT = 50;
const LOBBY_CHURN_PER_SECOND = 10;

test("大厅订阅风暴只按人数出帧：200 人进大厅不再放大成 200×200 帧", async () => {
  const { service } = createTestContext();
  let lobbyBytes = 0;
  let lobbyFrames = 0;
  const metered = (id: string): TestConnection => {
    const record: ConnectionRecord = {
      id,
      lobbySubscribed: false,
      send: (payload) => {
        if ((payload as { event?: string }).event !== WHOISFAKER_LOBBY_ROOMS_EVENT) return;
        lobbyFrames += 1;
        lobbyBytes += websocketFrameBytes(utf8Bytes(payload));
      },
      close: () => {},
    };
    service.registerConnection(record);
    return { record, sent: [], closed: [] };
  };

  // 建房时大厅里还没有订阅者：这一段是冷启动，不计入大厅稳态流量。
  for (let index = 0; index < LOBBY_ROOM_COUNT; index += 1) {
    await execute(service, metered(`lobby-host-${index}`), {
      id: `create-${index}`,
      type: "room.create",
      payload: {
        roomId: `${8000 + index}`,
        name: `承载测试房间${index}`,
        visibility: "public",
        allowSpectators: true,
        userName: `玩家${index}`,
      },
    });
  }
  expect(lobbyFrames).toBe(0);
  lobbyBytes = 0;

  for (let index = 0; index < LOBBY_SUBSCRIBERS; index += 1) {
    await execute(service, metered(`lobby-${index}`), {
      id: `sub-${index}`,
      type: "lobby.subscribeRooms",
      payload: {},
    });
  }

  // 旧写法里每订阅一次就向全服重发一遍整张表：N 人打开大厅 = N×N 帧。
  expect(lobbyFrames).toBe(LOBBY_SUBSCRIBERS);
  console.info(
    `大厅订阅风暴: ${LOBBY_SUBSCRIBERS} 人 × ${LOBBY_ROOM_COUNT} 房共 ${(lobbyBytes / 1024).toFixed(0)} KiB，人均 ${(lobbyBytes / LOBBY_SUBSCRIBERS / 1024).toFixed(1)} KiB`
  );
}, 30_000);

test("合并窗把大厅扇出的帧率封顶在 1/窗，变更到可见仍不超过一个窗", () => {
  const summaries: WhoIsFakerRoomSummary[] = Array.from(
    { length: LOBBY_ROOM_COUNT },
    (_, index) => ({
      roomId: `${8000 + index}`,
      name: `承载测试房间${index}`,
      visibility: index % 4 === 0 ? "private" : "public",
      allowSpectators: true,
      hasPassword: index % 4 === 0,
      playerCount: (index % 8) + 2,
      spectatorCount: index % 3,
      onlineCount: (index % 8) + 2,
      phase: WHOISFAKER_PHASES[index % WHOISFAKER_PHASES.length],
      testMode: false,
    })
  );

  const run = (windowMs: number) => {
    const registry = new ConnectionRegistry();
    let bytes = 0;
    let frames = 0;
    for (let index = 0; index < LOBBY_SUBSCRIBERS; index += 1) {
      registry.registerConnection({
        id: `lobby-${index}`,
        lobbySubscribed: true,
        send: (payload) => {
          frames += 1;
          bytes += websocketFrameBytes(utf8Bytes(payload));
        },
        close: () => {},
      });
    }
    let now = 0;
    let pending: { at: number; flush: () => void } | undefined;
    const changeTimes: number[] = [];
    const publishTimes: number[] = [];
    const fanout = new LobbyFanout({
      event: WHOISFAKER_LOBBY_ROOMS_EVENT,
      now: () => now,
      broadcast: (payload) => {
        publishTimes.push(now);
        registry.broadcastToLobby(payload);
      },
      summaries: () => summaries,
      windowMs,
      schedule: (flush, delayMs) => {
        pending = { at: now + delayMs, flush };
      },
    });

    for (
      let mutation = 0;
      mutation < LOBBY_CHURN_PER_SECOND * TEST_DURATION_SECONDS;
      mutation += 1
    ) {
      now += 1_000 / LOBBY_CHURN_PER_SECOND;
      const due = pending;
      if (due && due.at <= now) {
        pending = undefined;
        due.flush();
      }
      changeTimes.push(now);
      fanout.request();
    }
    // 仿真收束：最后一段突发仍要由尾沿带出去，否则「变更必被投递」这条不变量没法核对。
    if (pending) {
      now = Math.max(now, pending.at);
      pending.flush();
    }

    // 每次变更都必须被某一份列表带出去，且等待不超过一个窗口——合并只推迟可见，不丢内容。
    let maxDelayMs = 0;
    for (const changedAt of changeTimes) {
      const deliveredAt = publishTimes.find((at) => at >= changedAt);
      expect(deliveredAt).toBeNumber();
      maxDelayMs = Math.max(maxDelayMs, deliveredAt! - changedAt);
    }
    return { bytes, frames, publishes: publishTimes.length, maxDelayMs };
  };

  const merged = run(LOBBY_MERGE_WINDOW_MS);
  const perChange = run(0);
  const mergedMbps = (merged.bytes * TRANSPORT_OVERHEAD_RATIO * 8) / TEST_DURATION_SECONDS;
  console.info(
    `大厅扇出对照: ${LOBBY_CHURN_PER_SECOND} 变更/秒 × ${LOBBY_SUBSCRIBERS} 订阅者 → 逐变更 ${perChange.publishes} 帧/人 ${(perChange.bytes * TRANSPORT_OVERHEAD_RATIO * 8) / TEST_DURATION_SECONDS / 1_000_000} Mbps，合并窗 ${merged.publishes} 帧/人 ${(mergedMbps / 1_000_000).toFixed(2)} Mbps（ ${(perChange.bytes / merged.bytes).toFixed(2)}× 包体）`
  );

  expect(merged.publishes).toBeLessThanOrEqual(
    Math.ceil((TEST_DURATION_SECONDS * 1_000) / LOBBY_MERGE_WINDOW_MS) + 1
  );
  expect(merged.maxDelayMs).toBeLessThanOrEqual(LOBBY_MERGE_WINDOW_MS);
  expect(perChange.bytes / merged.bytes).toBeGreaterThanOrEqual(2);
}, 30_000);
