import { afterEach, describe, expect, test } from "bun:test";
import { ROOM_IDLE_TIMEOUT_MS, PLAYER_OFFLINE_CLEANUP_TIMEOUT_MS } from "../src/config/Constants";
import type { WhoIsFakerPrivateState, WhoIsFakerRoomSnapshot } from "../src/domain/Model";
import type { WhoIsFakerClientMessage } from "../src/shared/Index";
import { createConnection, createTestContext, execute, getLastEventPayload, type TestConnection } from "./Helpers";

type WithoutId<T> = T extends unknown ? Omit<T, "id"> : never;
const contexts: ReturnType<typeof createTestContext>[] = [];
afterEach(async () => {
  for (const context of contexts.splice(0)) {
    context.advanceTime(ROOM_IDLE_TIMEOUT_MS + 1);
    await context.service.runHousekeeping();
    await context.service.drainPendingWrites();
  }
});

/** 非 Oblivionis；9 个真实连接、8 位参赛者、生产命令开局，不跳阶段或改内部状态。 */
async function setup(separateHost = false) {
  const context = createTestContext(); contexts.push(context);
  const { service } = context; const roomId = "8931";
  let commandId = 0;
  const send = (client: TestConnection, message: WithoutId<WhoIsFakerClientMessage>) => execute(service, client,
    { ...message, id: `manual-${++commandId}` } as WhoIsFakerClientMessage);
  const connect = (id: string) => {
    const client = createConnection(service, id);
    // Housekeeping 使用校准通道；正常连接必须接收它，不能把旧快照当作状态死锁。
    client.record.sendStateSyncCalibration = client.record.send;
    return client;
  };
  const host = connect("manual-host");
  await send(host, { type: "room.create", payload: {
    roomId, name: "手动主持生命周期", userName: "房主", visibility: "public", allowSpectators: true,
  } });
  const clients: TestConnection[] = [host];
  for (let index = 1; index <= 8; index++) {
    const client = connect(`manual-${index}`); clients.push(client);
    await send(client, { type: "room.join", roomId, payload: { userName: `玩家${index}` } });
  }
  const questioner = separateHost ? clients[8] : host;
  await send(questioner, { type: "player.setSpectator", payload: { spectator: true } });
  await send(host, { type: "room.updateSettings", payload: {
    roleConfig: { undercoverCount: 1, hasBlank: true, hasAngel: false },
  } });
  const players = clients.filter(client => client !== questioner);
  for (const player of players) await send(player, { type: "player.setReady", payload: { ready: true } });
  await send(host, { type: "game.advancePhase", payload: {} });
  await send(host, { type: "game.assignQuestioner", payload: { playerId: questioner.record.playerId! } });
  await send(questioner, { type: "game.submitWords", payload: { words: ["苹果", "香蕉"], blankHint: "水果" } });
  const privateState = (client: TestConnection) => getLastEventPayload<WhoIsFakerPrivateState>(client, "game.privateState")!;
  const blank = players.find(player => privateState(player).role === "blank")!;
  const observer = players.find(player => player !== blank)!;
  const snapshot = (client = observer) => getLastEventPayload<WhoIsFakerRoomSnapshot>(client, "room.snapshot")!;
  const tick = async (ms: number) => { context.advanceTime(ms); await service.runHousekeeping(); };
  const enter = () => send(blank, { type: "game.enterBlankGuess", payload: {} });
  const pendingReview = async () => {
    await send(blank, { type: "game.submitBlankGuess", payload: { words: ["梨子", "葡萄"] } });
    expect(snapshot().status.blankGuessPendingReview).toBe(true);
  };
  const start = (durationSeconds: 60 | 120 | 180, actor = questioner) => send(actor,
    { type: "game.startPhaseTimer", payload: { durationSeconds } });
  const stop = (actor = questioner) => send(actor, { type: "game.stopPhaseTimer", payload: {} });
  const review = (approve: boolean, actor = questioner) => send(actor,
    { type: "game.reviewBlankGuess", payload: { approve } });
  const chatFor = async (minutes: number) => {
    for (let minute = 0; minute < minutes; minute++) {
      context.advanceTime(60_000);
      await send(observer, { type: "chat.send", payload: { text: `聊天续活${minute}` } });
      await service.runHousekeeping();
      expect(snapshot().status.phase).toBe("blankGuess");
      expect(snapshot().status.phaseTimer).toBeUndefined();
      expect(service.getHealthSnapshot().roomCount).toBe(1);
    }
  };
  const advanceDescriptions = async () => {
    expect(snapshot().status.phase).toBe("description");
    for (const player of players) {
      if (!snapshot().players.some(item => item.id === player.record.playerId && item.online)) continue;
      await send(player, { type: "game.submitDescription", payload: { text: `正常发言${player.record.id}` } });
    }
    await send(questioner, { type: "game.advancePhase", payload: {} });
    expect(snapshot().status.phase).toBe("voting");
  };
  expect(snapshot().testMode).toBe(false);
  expect(snapshot().status.phase).toBe("description");
  expect(snapshot().players.filter(player => player.roundStatus === "alive")).toHaveLength(8);
  expect(blank).toBeDefined(); expect(privateState(blank).canSubmitBlankGuess).toBe(true);
  expect(privateState(questioner).isQuestioner).toBe(true);
  return { ...context, clients, players, host, questioner, blank, observer, snapshot, privateState,
    send, tick, enter, pendingReview, start, stop, review, chatFor, advanceDescriptions };
}

describe("正常房间手动主持的白板生命周期", () => {
  test("在线白板不提交但聊天续活超过20分钟：无隐含180秒截止，授权主持计时仍可推进", async () => {
    const h = await setup(); await h.enter();
    await h.chatFor(21);
    expect(h.snapshot().status.blankGuessPlayerId).toBe(h.blank.record.playerId);
    expect(h.privateState(h.blank).canSubmitBlankGuess).toBe(true);
    await h.start(60); await h.tick(60_000);
    expect(h.snapshot().status.phase).toBe("description");
    expect(h.privateState(h.blank).blankGuessUsed).toBe(true);
    await h.advanceDescriptions();
  });

  for (const approve of [false, true]) test(`在线人工裁定聊天续活，取消计时后仍可主动裁定（批准${approve}）`, async () => {
    const h = await setup(); await h.enter(); await h.pendingReview(); await h.chatFor(21);
    expect(h.privateState(h.blank).canSubmitBlankGuess).toBe(false);
    await h.start(180); await h.stop(); await h.tick(180_001);
    expect(h.snapshot().status.blankGuessPendingReview).toBe(true);
    await h.review(approve);
    expect(h.snapshot().status.phase).toBe(approve ? "gameOver" : "description");
    if (!approve) await h.advanceDescriptions();
  });

  for (const duration of [60, 120, 180] as const) for (const adjudicating of [false, true]) {
    test(`主持开/取消/重开计时按当前时刻生效且取消不保留旧截止（${duration}秒裁定${adjudicating}）`, async () => {
      const h = await setup(); await h.enter(); if (adjudicating) await h.pendingReview();
      await h.start(duration);
      const firstEnd = h.snapshot().status.phaseTimer!.endsAt;
      await h.tick(30_000); await h.stop();
      expect(h.snapshot().status.phaseTimer).toBeUndefined();
      await h.tick(duration * 1000 + 1);
      expect(h.snapshot().status.phase).toBe("blankGuess");
      await h.start(duration);
      const timer = h.snapshot().status.phaseTimer!;
      expect(timer.endsAt).toBe(firstEnd + 30_000 + duration * 1000 + 1);
      expect(timer.durationSeconds).toBe(duration);
      await h.tick(duration * 1000 - 1);
      expect(h.snapshot().status.phase).toBe("blankGuess");
      await h.tick(1);
      expect(h.snapshot().status.phase).toBe("description");
      expect(h.snapshot().status.phaseTimer).toBeUndefined();
      await h.advanceDescriptions();
    });
  }

  test("取消计时后白板主动提交精确词对仍立即获胜", async () => {
    const h = await setup(); await h.enter(); await h.start(60); await h.stop();
    await h.tick(180_001);
    await h.send(h.blank, { type: "game.submitBlankGuess", payload: { words: ["苹果", "香蕉"] } });
    expect(h.snapshot().status.phase).toBe("gameOver");
    expect(h.snapshot().summary?.winner).toBe("blank");
  });

  test("非出题人不能开关计时或裁定，被拒命令不撤销实际计时器", async () => {
    const h = await setup(); await h.enter(); await h.pendingReview(); await h.start(120);
    const timer = h.snapshot().status.phaseTimer!;
    await expect(h.start(60, h.observer)).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(h.stop(h.observer)).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(h.review(false, h.observer)).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect(h.snapshot().status.phaseTimer).toEqual(timer);
    await h.tick(120_000); expect(h.snapshot().status.phase).toBe("description");
  });

  test("房主与出题人不同：房主不是计时/裁定者，但出题人操作不受阻且房主可移出出题人终止", async () => {
    const h = await setup(true); await h.enter(); await h.pendingReview();
    await expect(h.start(60, h.host)).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(h.stop(h.host)).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(h.review(false, h.host)).rejects.toMatchObject({ code: "FORBIDDEN" });
    await h.start(180); await h.stop(); await h.start(60);
    await h.send(h.host, { type: "room.kick", payload: { playerId: h.questioner.record.playerId! } });
    expect(h.snapshot().status.phase).toBe("gameOver");
    expect(h.snapshot().summary?.winner).toBe("aborted");
    expect(h.snapshot().status.phaseTimer).toBeUndefined();
  });

  for (const adjudicating of [false, true]) for (const cancelFallback of [false, true]) {
    test(`白板掉线待决→等待60秒；${cancelFallback ? "取消后主持仍有重开出口" : "默认到期自动恢复"}（裁定${adjudicating}）`, async () => {
      const h = await setup(); await h.enter(); if (adjudicating) await h.pendingReview();
      await h.service.unregisterConnection(h.blank.record.id);
      expect(h.snapshot().status.pendingDisconnectPlayerId).toBe(h.blank.record.playerId!);
      await expect(h.start(60)).rejects.toMatchObject({ code: "PLAYER_PENDING" });
      await h.send(h.questioner, { type: "game.resolveDisconnect", payload: { playerId: h.blank.record.playerId!, resolution: "wait" } });
      expect(h.snapshot().status.phaseTimer?.durationSeconds).toBe(60);
      if (cancelFallback) {
        await h.stop(); await h.tick(60_001);
        expect(h.snapshot().status.phase).toBe("blankGuess");
        expect(h.snapshot().status.phaseTimer).toBeUndefined();
        await h.start(60);
      }
      await h.tick(59_999); expect(h.snapshot().status.phase).toBe("blankGuess");
      await h.tick(1); expect(h.snapshot().status.phase).toBe("description");
      expect(h.snapshot().status.pendingDisconnectPlayerId).toBe(h.blank.record.playerId!);
      await h.send(h.questioner, { type: "game.resolveDisconnect", payload: { playerId: h.blank.record.playerId!, resolution: "eliminate" } });
      await h.advanceDescriptions();
    });
  }

  for (const adjudicating of [false, true]) test(`取消掉线等待计时后，既有离线席位清理仍收束而非在线自动180秒（裁定${adjudicating}）`, async () => {
    const h = await setup(); await h.enter(); if (adjudicating) await h.pendingReview();
    await h.service.unregisterConnection(h.blank.record.id);
    await h.send(h.questioner, { type: "game.resolveDisconnect", payload: { playerId: h.blank.record.playerId!, resolution: "wait" } });
    await h.stop();
    await h.tick(PLAYER_OFFLINE_CLEANUP_TIMEOUT_MS - 1);
    expect(h.snapshot().status.phase).toBe("blankGuess");
    expect(h.snapshot().status.phaseTimer).toBeUndefined();
    await h.tick(1);
    expect(h.snapshot().status.phase).toBe("description");
    expect(h.snapshot().players.some(player => player.id === h.blank.record.playerId)).toBe(false);
    await h.advanceDescriptions();
  });

  for (const adjudicating of [false, true]) test(`白板在等待60秒内恢复连接仍可主动推进（裁定${adjudicating}）`, async () => {
    const h = await setup(); await h.enter(); if (adjudicating) await h.pendingReview();
    const sessionToken = h.privateState(h.blank).sessionToken;
    await h.service.unregisterConnection(h.blank.record.id);
    await h.send(h.questioner, { type: "game.resolveDisconnect", payload: { playerId: h.blank.record.playerId!, resolution: "wait" } });
    await h.tick(30_000);
    const restored = createConnection(h.service, "restored-blank");
    await h.send(restored, { type: "room.reconnect", payload: { roomId: "8931", sessionToken } });
    expect(h.snapshot().status.pendingDisconnectPlayerId).toBeUndefined();
    if (adjudicating) await h.review(true);
    else await h.send(restored, { type: "game.submitBlankGuess", payload: { words: ["苹果", "香蕉"] } });
    expect(h.snapshot().status.phase).toBe("gameOver");
    expect(h.snapshot().summary?.winner).toBe("blank");
    expect(h.snapshot().status.phaseTimer).toBeUndefined();
  });

  test("转让房主不撤销既有出题人的计时与裁定权", async () => {
    const h = await setup(); await h.enter(); await h.pendingReview();
    await h.send(h.host, { type: "room.transferHost", payload: { playerId: h.observer.record.playerId! } });
    expect(h.snapshot().hostPlayerId).toBe(h.observer.record.playerId!);
    await expect(h.start(60, h.observer)).rejects.toMatchObject({ code: "FORBIDDEN" });
    await h.start(120); await h.stop(); await h.start(180); await h.review(false);
    expect(h.snapshot().status.phase).toBe("description");
    await h.advanceDescriptions();
  });

  for (const adjudicating of [false, true]) test(`普通推进不能绕过白板，但其拒绝不封死授权计时出口（裁定${adjudicating}）`, async () => {
    const h = await setup(); await h.enter(); if (adjudicating) await h.pendingReview();
    await expect(h.send(h.questioner, { type: "game.advancePhase", payload: {} })).rejects.toMatchObject({ code: "INVALID_PHASE" });
    await h.start(60); await h.stop(); await h.start(60); await h.tick(60_000);
    expect(h.snapshot().status.phase).toBe("description");
  });

  for (const adjudicating of [false, true]) for (const removal of ["leave", "kick"] as const) {
    test(`白板${removal}即时收束，取消旧计时不影响离场出口（裁定${adjudicating}）`, async () => {
      const h = await setup(); await h.enter(); if (adjudicating) await h.pendingReview();
      await h.start(180); await h.stop();
      if (removal === "leave") await h.send(h.blank, { type: "room.leave", payload: {} });
      else await h.send(h.host, { type: "room.kick", payload: { playerId: h.blank.record.playerId! } });
      expect(h.snapshot().status.phase).toBe("description");
      expect(h.snapshot().status.blankGuessPlayerId).toBeUndefined();
      expect(h.snapshot().status.phaseTimer).toBeUndefined();
      await h.advanceDescriptions();
    });
  }

  for (const adjudicating of [false, true]) for (const removal of ["leave", "kick", "disconnect"] as const) {
    test(`出题人${removal}在阻塞阶段仍有终止路径（裁定${adjudicating}）`, async () => {
      const h = await setup(removal === "kick"); await h.enter(); if (adjudicating) await h.pendingReview();
      await h.start(120); await h.stop();
      if (removal === "disconnect") {
        await h.service.unregisterConnection(h.questioner.record.id);
        expect(h.snapshot().status.questionerReconnectDeadlineAt).toBeDefined();
        await h.tick(59_999); expect(h.snapshot().status.phase).toBe("blankGuess");
        await h.tick(1);
      } else if (removal === "leave") await h.send(h.questioner, { type: "room.leave", payload: {} });
      else await h.send(h.host, { type: "room.kick", payload: { playerId: h.questioner.record.playerId! } });
      expect(h.snapshot().status.phase).toBe("gameOver");
      expect(h.snapshot().summary?.winner).toBe("aborted");
      expect(h.snapshot().status.phaseTimer).toBeUndefined();
    });
  }
});
