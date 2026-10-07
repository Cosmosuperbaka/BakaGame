import { expect, spyOn, test } from "bun:test";

import { PHASE_RESULT_DISPLAY_MS } from "../src/config/Constants";
import type { WhoIsFakerPrivateState, WhoIsFakerRoomSnapshot } from "../src/domain/Model";
import type { WhoIsFakerClientMessage, EventPacket, WhoIsFakerRole, StateSyncPayload } from "../src/shared/Index";
import { StateSyncEncoder } from "../src/transport/StateSync";
import { createConnection, createTestContext, execute, type TestConnection } from "./Helpers";

type WithoutId<T> = T extends unknown ? Omit<T, "id"> : never;
type ViewClient = TestConnection & { raw: EventPacket[]; wire: EventPacket[]; sessionToken: string };

// 真实开局、投票淘汰与旁观者身份；每批清理历史，避免建房广播占用夹具内存。
const setupViews = async (connectionCount = 150) => {
  const context = createTestContext();
  const { service } = context;
  const roomId = "8940";
  let commandId = 0, networkNow = 0, encode = false;
  const clients: ViewClient[] = [];
  function connect(index: number): ViewClient {
    const connection = createConnection(service, `view-${index}`);
    const encoder = new StateSyncEncoder({ now: () => networkNow });
    const raw: EventPacket[] = [], wire: EventPacket[] = [];
    const receive = (payload: unknown, calibration = false) => {
      const event = payload as EventPacket;
      if (event.type !== "event" || !["room.snapshot", "game.privateState"].includes(event.event)) return;
      raw.push(event);
      if (event.event === "game.privateState") client.sessionToken = (event.payload as WhoIsFakerPrivateState).sessionToken;
      if (encode) wire.push(...encoder.encode(payload, { calibration }) as EventPacket[]);
    };
    connection.record.send = payload => receive(payload);
    connection.record.sendStateSyncCalibration = payload => receive(payload, true);
    connection.record.resetStateSync = () => encoder.reset();
    const client: ViewClient = { ...connection, raw, wire, sessionToken: "" };
    clients.push(client);
    return client;
  }
  const clear = () => {
    for (const client of clients) { client.raw.length = 0; client.wire.length = 0; }
  };
  const command = async (client: typeof clients[number], message: WithoutId<WhoIsFakerClientMessage>) => {
    clear();
    return execute(service, client, { ...message, id: `view-cmd-${++commandId}` } as WhoIsFakerClientMessage);
  };
  const host = connect(0);
  await command(host, { type: "room.create", payload: {
    roomId, name: "权限视图复用", userName: "出题人", visibility: "public", allowSpectators: true,
  } });
  // spectator 身份的出题人仍不能看 ghost；不能简单按 membership 分组。
  await command(host, { type: "player.setSpectator", payload: { spectator: true } });
  const active: ViewClient[] = [];
  for (let index = 1; index < connectionCount - 3; index++) {
    const client = connect(index); active.push(client);
    await command(client, { type: "room.join", roomId, payload: { userName: `玩家${index}` } });
  }
  await command(host, { type: "room.updateSettings", payload: {
    roleConfig: { undercoverCount: 1, hasBlank: false, hasAngel: false },
  } });
  for (const client of active) await command(client, { type: "player.setReady", payload: { ready: true } });
  await command(host, { type: "game.advancePhase", payload: {} });
  await command(host, { type: "game.assignQuestioner", payload: { playerId: host.record.playerId! } });
  const manualRoles: Record<string, WhoIsFakerRole> = Object.fromEntries(active.map((client, index) => [
    client.record.playerId!, index === active.length - 1 ? "undercover" : "civilian",
  ]));
  await command(host, { type: "game.submitWords", payload: { words: ["苹果", "香蕉"], manualRoles } });
  for (const client of active) await command(client, { type: "game.submitDescription", payload: { text: "描述" } });
  await command(host, { type: "game.advancePhase", payload: {} });
  const dead = active[0];
  for (const client of active) await command(client, { type: "game.submitVote", payload: {
    targetId: client === dead ? active[1].record.playerId! : dead.record.playerId!,
  } });
  await command(host, { type: "game.advancePhase", payload: {} });
  expect(snapshot(host).status.phase).toBe("feedback");
  // 投票反馈：出题人继续后入夜。
  await command(host, { type: "game.advancePhase", payload: {} });
  const spectators: ViewClient[] = [];
  for (let index = connectionCount - 3; index < connectionCount; index++) {
    const client = connect(index); spectators.push(client);
    await command(client, { type: "room.join", roomId, payload: { userName: `旁观${index}` } });
  }
  expect(snapshot(host).status.phase).toBe("night");
  expect(snapshot(host).players.find(player => player.id === dead.record.playerId)?.roundStatus).toBe("dead");
  clear();
  return {
    ...context, clients, host, dead, active, spectators,
    visible: [dead, ...spectators], hidden: [host, ...active.slice(1)], command, clear,
    enableEncoding: () => { encode = true; },
    advanceNetwork: (ms: number) => { networkNow += ms; context.advanceTime(ms); },
  };
};

const rawPayload = <T>(client: ViewClient, event: string): T =>
  client.raw.filter(packet => packet.event === event).at(-1)!.payload as T;
const snapshot = (client: ViewClient) => rawPayload<WhoIsFakerRoomSnapshot>(client, "room.snapshot");
const syncPayload = <T>(client: ViewClient, event: string) =>
  client.wire.filter(packet => packet.event === event).at(-1)!.payload as StateSyncPayload<T>;

const assertViews = (f: Awaited<ReturnType<typeof setupViews>>) => {
  expect(new Set(f.clients.map(snapshot)).size).toBe(2);
  expect(Object.isFrozen(snapshot(f.hidden[0]))).toBe(true);
  expect(Object.isFrozen(snapshot(f.visible[0]))).toBe(true);
  for (const client of f.hidden) {
    expect(snapshot(client)).toBe(snapshot(f.hidden[0]));
    expect(snapshot(client).chat.some(message => message.channel === "ghost")).toBe(false);
  }
  for (const client of f.visible) {
    expect(snapshot(client)).toBe(snapshot(f.visible[0]));
    expect(snapshot(client)).not.toBe(snapshot(f.hidden[0]));
    expect(snapshot(client).chat.some(message => message.channel === "ghost")).toBe(true);
  }
  const states = f.clients.map(client => rawPayload<WhoIsFakerPrivateState>(client, "game.privateState"));
  expect(new Set(states).size).toBe(f.clients.length);
  expect(new Set(states.map(state => state.sessionToken)).size).toBe(f.clients.length);
  for (const [index, state] of states.entries()) {
    expect(state.playerId).toBe(f.clients[index].record.playerId!);
    expect(state.sessionToken).toBe(f.clients[index].sessionToken);
  }
};

// 计数真实 StateSync 准备，不替换编码器或业务逻辑；每次测量后恢复 spy。
const measureClones = async (operation: () => Promise<unknown>) => {
  const clone = globalThis.structuredClone;
  let publicClones = 0, privateClones = 0;
  const spy = spyOn(globalThis, "structuredClone").mockImplementation((value, options) => {
    if (value && typeof value === "object") {
      if ("roomId" in value && "players" in value && "chat" in value) publicClones++;
      if ("playerId" in value && "sessionToken" in value) privateClones++;
    }
    return clone(value, options);
  });
  const startedAt = performance.now();
  const cpuBefore = process.cpuUsage();
  const heapBefore = process.memoryUsage().heapUsed;
  try {
    await operation();
    console.info("Faker编码准备测量:", JSON.stringify({
      publicClones, privateClones, elapsedMs: performance.now() - startedAt,
      cpuMicros: process.cpuUsage(cpuBefore), heapDeltaBytes: process.memoryUsage().heapUsed - heapBefore,
    }));
    return { publicClones, privateClones };
  }
  finally { spy.mockRestore(); }
};

test("150连接按ghost权限复用公开对象和编码准备，私有状态仍逐连接隔离", async () => {
  const f = await setupViews();
  f.enableEncoding();
  const clones = await measureClones(() => f.command(f.spectators[0], { type: "chat.send", payload: { text: "观战秘密" } }));
  assertViews(f);
  expect(clones).toEqual({ publicClones: 2, privateClones: 150 });
  const fullStates = f.clients.map(client => {
    const sync = syncPayload<WhoIsFakerRoomSnapshot>(client, "room.snapshot");
    expect(sync.mode).toBe("full");
    return sync.mode === "full" ? sync.state : undefined;
  });
  expect(new Set(fullStates).size).toBe(2);
  const firstViews = f.clients.map(snapshot);
  const nextClones = await measureClones(() => f.command(f.active[1], { type: "chat.send", payload: { text: "公开消息" } }));
  assertViews(f);
  expect(nextClones).toEqual({ publicClones: 2, privateClones: 150 });
  for (const [index, client] of f.clients.entries()) expect(snapshot(client)).not.toBe(firstViews[index]);
  const patches = f.clients.map(client => {
    const sync = syncPayload<WhoIsFakerRoomSnapshot>(client, "room.snapshot");
    expect(sync.mode).toBe("patch");
    return sync.mode === "patch" ? sync.operations : undefined;
  });
  // 相同当前视图和相同基线只生成一份操作数组；两组权限分别复用。
  expect(new Set(patches).size).toBe(2);
  console.info("Faker 150连接准备计数:", JSON.stringify({ first: clones, next: nextClones, patchIdentities: new Set(patches).size }));
  await f.command(f.dead, { type: "chat.send", payload: { text: "亡者秘密" } });
  assertViews(f);
  // 满员建房历史触及 CHAT_LIMIT 时，ghost 追加也可能挤掉旧主频道消息；
  // 允许对应 remove 补丁，但编码内容不能包含新 ghost 消息。
  for (const client of f.hidden) expect(JSON.stringify(client.wire)).not.toContain("亡者秘密");
  for (const client of f.visible) {
    expect(syncPayload<WhoIsFakerRoomSnapshot>(client, "room.snapshot").mode).toBe("patch");
    expect(snapshot(client).chat.some(message => message.text === "亡者秘密")).toBe(true);
  }
});

test("150连接无变化校准复用权限视图且全量修复丢失补丁，两个通道均保持最终真相", async () => {
  const f = await setupViews(); f.enableEncoding();
  await f.command(f.spectators[0], { type: "chat.send", payload: { text: "观战秘密" } });
  const initial = f.clients.map(client => syncPayload<WhoIsFakerRoomSnapshot>(client, "room.snapshot"));
  await f.command(f.active[1], { type: "chat.send", payload: { text: "遗漏的更新" } });
  const updated = f.clients.map(client => syncPayload<WhoIsFakerRoomSnapshot>(client, "room.snapshot"));
  const beforeCalibration = f.clients.map(snapshot);
  f.advanceNetwork(59_999); f.clear();
  await f.service.runHousekeeping(); assertViews(f);
  expect(f.clients.every(client => client.wire.length === 0)).toBe(true);
  f.advanceNetwork(1); f.clear();
  const clones = await measureClones(() => f.service.runHousekeeping());
  assertViews(f);
  expect(clones).toEqual({ publicClones: 2, privateClones: 150 });
  const fullStates = f.clients.map((client, index) => {
    expect(client.wire).toHaveLength(2);
    const sync = syncPayload<WhoIsFakerRoomSnapshot>(client, "room.snapshot");
    const privateSync = syncPayload<WhoIsFakerPrivateState>(client, "game.privateState");
    expect(sync.mode).toBe("full"); expect(privateSync.mode).toBe("full");
    expect(sync.revision).toBe(updated[index].revision); expect(privateSync.revision).toBe(1);
    if (sync.mode !== "full" || privateSync.mode !== "full") throw new Error("校准缺少全量");
    expect(sync.state).toEqual(beforeCalibration[index]); expect(sync.state).toEqual(snapshot(client));
    expect(privateSync.state).toEqual(rawPayload<WhoIsFakerPrivateState>(client, "game.privateState"));
    const stale = initial[index];
    if (stale.mode !== "full") throw new Error("初始基线缺少全量");
    // 消费者故意丢弃中间补丁，当前全量无需旧基线便能恢复。
    expect(stale.state.chat.some(message => message.text === "遗漏的更新")).toBe(false);
    expect(sync.state.chat.some(message => message.text === "遗漏的更新")).toBe(true);
    return sync.state;
  });
  expect(new Set(fullStates).size).toBe(2);
  console.info("Faker 150连接校准准备计数:", JSON.stringify(clones));
});

test("目标同步和阶段切换重新核算ghost权限，不跨发布缓存或泄露私有字段", async () => {
  const f = await setupViews(12);
  await f.command(f.spectators[0], { type: "chat.send", payload: { text: "观战秘密" } });
  assertViews(f);
  for (const client of [f.host, f.active[1], f.dead, f.spectators[0]]) {
    await f.command(client, { type: "room.requestSync", payload: {} });
    expect(f.clients.filter(peer => peer.raw.length > 0)).toEqual([client]);
    expect(snapshot(client).chat.some(message => message.channel === "ghost")).toBe(f.visible.includes(client));
    expect(rawPayload<WhoIsFakerPrivateState>(client, "game.privateState").playerId).toBe(client.record.playerId!);
    expect(JSON.stringify(snapshot(client))).not.toContain(client.sessionToken);
    expect(snapshot(client)).not.toHaveProperty("globalWords");
  }
  // 真正结束对局，验证活跃阶段之外全房归并为同一个视图。
  const alive = f.active.slice(1), undercover = alive.at(-1)!;
  for (const client of alive) await f.command(client, { type: "game.submitNightAction", payload: { targetId: null } });
  await f.command(f.host, { type: "game.advancePhase", payload: {} });
  await f.command(f.host, { type: "game.advancePhase", payload: {} });
  for (const client of alive) await f.command(client, { type: "game.submitDescription", payload: { text: "第二天描述" } });
  await f.command(f.host, { type: "game.advancePhase", payload: {} });
  for (const client of alive) await f.command(client, { type: "game.submitVote", payload: {
    targetId: client === undercover ? alive[0].record.playerId! : undercover.record.playerId!,
  } });
  await f.command(f.host, { type: "game.advancePhase", payload: {} });
  // 反馈阶段仍在局内，ghost 聊天继续按权限隔离。
  expect(snapshot(f.host).status.phase).toBe("feedback");
  expect(new Set(f.clients.map(snapshot)).size).toBe(2);
  await f.command(f.host, { type: "game.advancePhase", payload: {} });
  expect(snapshot(f.host).status.phase).toBe("gameOver");
  expect(new Set(f.clients.map(snapshot)).size).toBe(1);
  f.advanceTime(PHASE_RESULT_DISPLAY_MS);
  await f.command(f.host, { type: "game.advancePhase", payload: {} });
  expect(new Set(f.clients.map(snapshot)).size).toBe(1);
  for (const client of f.clients) {
    expect(snapshot(client).status.phase).toBe("waiting");
    expect(snapshot(client).chat.some(message => message.channel === "ghost")).toBe(true);
  }
});
