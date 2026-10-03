import { expect, test } from "bun:test";
import type { ClientMessage } from "../src/shared/Index";
import type { PrivateState, RoomSnapshot, RoomRecord, PlayerRole } from "../src/domain/Model";
import { createConnection, createTestContext, execute, getLastEventPayload } from "./Helpers";

type WithoutId<T> = T extends unknown ? Omit<T, "id"> : never;

// 正常开局与真实指令，不用调试跳阶段构造状态机前置条件。
const setupRound = async (roomId = "8920", botCount = 0) => {
  const context = createTestContext();
  const { service } = context;
  const questioner = createConnection(service, `${roomId}-questioner`);
  await execute(service, questioner, { id: "create", type: "room.create", payload: {
    roomId, name: "阶段回归", userName: "出题人", visibility: "public", allowSpectators: true,
  } });
  const participants: ReturnType<typeof createConnection>[] = [];
  for (let i = 0; i < 8 - botCount; i++) {
    const connection = createConnection(service, `${roomId}-${i}`);
    await execute(service, connection, { id: `join-${i}`, type: "room.join", roomId, payload: { userName: `玩家${i}` } });
    participants.push(connection);
  }
  let id = 0;
  const command = (connection: typeof questioner, message: WithoutId<ClientMessage>) =>
    execute(service, connection, { ...message, id: `cmd-${++id}` } as ClientMessage);
  if (botCount) await command(questioner, { type: "test.addBot", payload: { count: botCount } });
  await command(questioner, { type: "room.updateSettings", payload: { roleConfig: { undercoverCount: 1, hasBlank: true, hasAngel: false } } });
  for (const c of [questioner, ...participants]) await command(c, { type: "player.setReady", payload: { ready: true } });
  await command(questioner, { type: "game.advancePhase", payload: {} });
  await command(questioner, { type: "game.assignQuestioner", payload: { playerId: questioner.record.playerId! } });
  const manualRoles: Record<string, PlayerRole> = Object.fromEntries(getLastEventPayload<RoomSnapshot>(questioner, "room.snapshot")!.players.filter((p) => p.id !== questioner.record.playerId).map((p) => [p.id, p.id === participants[0].record.playerId ? "blank" : p.id === participants[1].record.playerId ? "undercover" : "civilian"]));
  await command(questioner, { type: "game.submitWords", payload: { words: ["苹果", "香蕉"], blankHint: "水果", manualRoles } });
  const snapshot = () => getLastEventPayload<RoomSnapshot>(questioner, "room.snapshot")!;
  const describeAll = async () => {
    for (const c of participants) await command(c, { type: "game.submitDescription", payload: { text: "描述" } });
  };
  const advance = () => command(questioner, { type: "game.advancePhase", payload: {} });
  const startTimer = () => command(questioner, { type: "game.startPhaseTimer", payload: { durationSeconds: 60 } });
  return { ...context, questioner, participants, blank: participants[0], command, snapshot, describeAll, advance, startTimer };
};

test("提前推进描述、投票、PK两子阶段及夜晚失败不撤销倒计时，原超时仅推进一次", async () => {
  const f = await setupRound();
  const assertRejectedKeepsTimer = async () => {
    await f.startTimer();
    const before = f.snapshot().status.phaseTimer;
    const timers = (f.service as unknown as { phaseTimerTimeoutByRoomId: Map<string, ReturnType<typeof setTimeout>> }).phaseTimerTimeoutByRoomId;
    const handle = timers.get("8920");
    await expect(f.advance()).rejects.toMatchObject({ code: "PHASE_INCOMPLETE" });
    expect(f.snapshot().status.phaseTimer).toEqual(before);
    expect(timers.get("8920")).toBe(handle);
    // 请求拒绝不会发布快照，因此再主动同步确认服务端真相源。
    await f.command(f.questioner, { type: "room.requestSync", payload: {} });
    expect(f.snapshot().status.phaseTimer).toEqual(before);
  };
  await assertRejectedKeepsTimer();
  f.advanceTime(60_001);
  await f.service.runHousekeeping();
  expect(f.snapshot().status.phase).toBe("voting");
  expect(f.snapshot().status.phaseTimer).toBeUndefined();
  await f.service.runHousekeeping();
  expect(f.snapshot().status.phase).toBe("voting");
  await assertRejectedKeepsTimer();
  // 4比4平票；成功推进撤销旧计时器。
  for (const [i, c] of f.participants.entries()) await f.command(c, { type: "game.submitVote", payload: { targetId: f.participants[[0, 1, 3, 4].includes(i) ? 2 : 3].record.playerId! } });
  await f.advance();
  expect(f.snapshot().status.phase).toBe("tieBreak");
  expect(f.snapshot().status.phaseTimer).toBeUndefined();
  await assertRejectedKeepsTimer();
  for (const c of f.participants.slice(2, 4)) await f.command(c, { type: "game.submitDescription", payload: { text: "PK" } });
  await f.advance();
  expect(f.snapshot().status.tieBreakStage).toBe("vote");
  await assertRejectedKeepsTimer();
  for (const c of f.participants.filter((_, i) => i !== 2 && i !== 3)) await f.command(c, { type: "game.submitVote", payload: { targetId: "abstain" } });
  await f.advance();
  expect(f.snapshot().status.phase).toBe("night");
  await assertRejectedKeepsTimer();
  f.advanceTime(60_001);
  await f.service.runHousekeeping();
  expect(f.snapshot().status.phase).toBe("description");
  expect(f.snapshot().status.phaseTimer).toBeUndefined();
});

for (const exit of ["reject", "reviewTimeout", "draftTimeout"] as const) {
  test(`白板打断补充后${exit}恢复补充模式、原票及剩余计时`, async () => {
    const f = await setupRound();
    await f.describeAll(); await f.advance();
    await f.command(f.participants[2], { type: "game.submitVote", payload: { targetId: f.participants[3].record.playerId! } });
    const vote = getLastEventPayload<PrivateState>(f.participants[2], "game.privateState")!.myCurrentVoteTargetId;
    await f.command(f.questioner, { type: "game.requestSupplement", payload: { playerIds: [f.participants[2].record.playerId!, f.participants[3].record.playerId!] } });
    await f.startTimer(); f.advanceTime(10_000);
    await f.command(f.blank, { type: "game.enterBlankGuess", payload: {} });
    if (exit !== "draftTimeout") await f.command(f.blank, { type: "game.submitBlankGuess", payload: { words: ["西瓜", "菠萝"] } });
    if (exit === "reject") await f.command(f.questioner, { type: "game.reviewBlankGuess", payload: { approve: false } });
    else { await f.startTimer(); f.advanceTime(60_001); await f.service.runHousekeeping(); }
    expect(f.snapshot().status.phase).toBe("description");
    expect(f.snapshot().status.speechMode).toBe("supplement");
    expect(f.snapshot().status.phaseTimer?.speechMode).toBe("supplement");
    expect(f.snapshot().status.phaseTimer?.durationSeconds).toBe(50);
    await expect(f.advance()).rejects.toMatchObject({ code: "PHASE_INCOMPLETE" });
    for (const c of f.participants.slice(2, 4)) await f.command(c, { type: "game.submitDescription", payload: { text: "补充" } });
    expect(f.snapshot().status.phase).toBe("voting");
    expect(f.snapshot().status.supplementIndex).toBeUndefined();
    expect(f.snapshot().status.phaseTimer).toBeUndefined();
    expect(getLastEventPayload<PrivateState>(f.participants[2], "game.privateState")!.myCurrentVoteTargetId).toBe(vote);
  });
}

for (const draft of [["", ""], ["苹果", ""], ["苹果", "苹果"], ["\u0000", "\u200b"], [" 苹果 ", "苹果\u200b"], ["西瓜", "菠萝"], ["香蕉", "苹果"]] as [string, string][]) {
  test(`到期草稿 ${JSON.stringify(draft)} 确定收束并只消耗一次`, async () => {
    const f = await setupRound();
    await f.command(f.blank, { type: "game.enterBlankGuess", payload: {} });
    await f.command(f.blank, { type: "game.updateBlankGuessDraft", payload: { words: draft } });
    // 中间态允许草稿，正式提交仍严格校验且不先消耗机会。
    if (draft[0] === draft[1]) await expect(f.command(f.blank, { type: "game.submitBlankGuess", payload: { words: draft } })).rejects.toMatchObject({ code: "INVALID_WORD_PAIR" });
    await f.startTimer(); f.advanceTime(60_001); await f.service.runHousekeeping();
    const success = draft[0] === "香蕉";
    expect(f.snapshot().status.phase).toBe(success ? "gameOver" : "description");
    expect(f.snapshot().status.blankGuessPlayerId).toBeUndefined();
    expect(getLastEventPayload<PrivateState>(f.blank, "game.privateState")!.blankGuessUsed).toBe(true);
    const room = (f.service as unknown as { rooms: Map<string, RoomRecord> }).rooms.get("8920")!;
    expect(room.round!.blankGuessRecords).toHaveLength(1);
    expect(room.round!.blankGuessRecords[0].success).toBe(success);
    await f.service.runHousekeeping();
    expect(room.round!.blankGuessRecords).toHaveLength(1);
  });
}

test("已投票离线玩家被点名补充即时待决，等待后仍可重连补交", async () => {
  const f = await setupRound(); await f.describeAll(); await f.advance();
  const offline = f.participants[2]; const playerId = offline.record.playerId!;
  await f.command(offline, { type: "game.submitVote", payload: { targetId: f.participants[3].record.playerId! } });
  const sessionToken = getLastEventPayload<PrivateState>(offline, "game.privateState")!.sessionToken;
  await f.service.unregisterConnection(offline.record.id);
  expect(f.snapshot().status.pendingDisconnectPlayerId).toBeUndefined();
  await f.command(f.questioner, { type: "game.requestSupplement", payload: { playerIds: [playerId] } });
  expect(f.snapshot().status.pendingDisconnectPlayerId).toBe(playerId);
  await f.command(f.questioner, { type: "game.resolveDisconnect", payload: { playerId, resolution: "wait" } });
  const reconnected = createConnection(f.service, "back");
  await f.command(reconnected, { type: "room.reconnect", payload: { roomId: "8920", sessionToken } });
  await f.command(reconnected, { type: "game.submitDescription", payload: { text: "补充" } });
  expect(f.snapshot().status.phase).toBe("voting");
  expect(f.snapshot().status.pendingDisconnectPlayerId).toBeUndefined();
});

test("真正残局白板猜错并判错按延后赢家结算，计分与上下文完整清理", async () => {
  const f = await setupRound(); await f.describeAll(); await f.advance();
  const undercoverId = f.participants[1].record.playerId!;
  for (const c of f.participants) await f.command(c, { type: "game.submitVote", payload: { targetId: c === f.participants[1] ? f.participants[2].record.playerId! : undercoverId } });
  await f.advance();
  expect(f.snapshot().status.phase).toBe("blankGuess");
  expect(f.snapshot().status.blankGuessReason).toBe("finale");
  const room = (f.service as unknown as { rooms: Map<string, RoomRecord> }).rooms.get("8920")!;
  expect(room.round!.blankGuessContext!.deferredWinner).toBe("good");
  await f.command(f.blank, { type: "game.submitBlankGuess", payload: { words: ["西瓜", "菠萝"] } });
  expect(f.snapshot().status.blankGuessPendingReview).toBe(true);
  await f.command(f.questioner, { type: "game.reviewBlankGuess", payload: { approve: false } });
  expect(f.snapshot().status.phase).toBe("gameOver");
  expect(f.snapshot().summary?.winner).toBe("good");
  expect(room.round!.summary!.awardedScores.find((entry) => entry.playerId === f.participants[2].record.playerId!)!.delta).toBe(1);
  expect(f.snapshot().players.find((entry) => entry.id === f.participants[2].record.playerId!)!.score).toBe(1);
  expect(f.snapshot().summary!.awardedScores.some((entry) => entry.playerId === f.blank.record.playerId)).toBe(false);
  expect(room.round!.blankGuessContext).toBeUndefined();
  expect(room.round!.phaseTimer).toBeUndefined();
});


for (const mixed of [false, true]) {
  test(`点名${mixed ? "人机混合" : "全机器人"}补充自动完成机器人部分并清理计时待决`, async () => {
    const f = await setupRound("Oblivionis", 2);
    await f.describeAll(); await f.advance();
    const bots = f.snapshot().players.filter((p) => p.isBot);
    const ids = bots.map((p) => p.id);
    if (mixed) ids.push(f.participants[2].record.playerId!);
    await f.command(f.questioner, { type: "game.requestSupplement", payload: { playerIds: ids } });
    expect(f.snapshot().descriptions.filter((d) => d.kind === "supplement").map((d) => d.playerId)).toEqual(bots.map((p) => p.id));
    if (mixed) {
      expect(f.snapshot().status.speechMode).toBe("supplement");
      expect(f.snapshot().status.submittedSpeechPlayerIds).toEqual(bots.map((p) => p.id));
      await expect(f.advance()).rejects.toMatchObject({ code: "PHASE_INCOMPLETE" });
      await f.startTimer();
      await f.command(f.participants[2], { type: "game.submitDescription", payload: { text: "真人补充" } });
    }
    expect(f.snapshot().status.phase).toBe("voting");
    expect(f.snapshot().status.supplementIndex).toBeUndefined();
    expect(f.snapshot().status.phaseTimer).toBeUndefined();
    expect(f.snapshot().status.pendingDisconnectPlayerId).toBeUndefined();
  });
}

for (const phase of ["description", "voting", "tieBreakDescription", "tieBreakVote", "night"] as const) {
  test(`白板从${phase}主动猜词判错保留阶段子状态与倒计时`, async () => {
    const f = await setupRound();
    if (phase !== "description") { await f.describeAll(); await f.advance(); }
    if (phase === "tieBreakDescription" || phase === "tieBreakVote") {
      for (const [i, c] of f.participants.entries()) await f.command(c, { type: "game.submitVote", payload: { targetId: f.participants[[0, 1, 3, 4].includes(i) ? 2 : 3].record.playerId! } });
      await f.advance();
      if (phase === "tieBreakVote") {
        for (const c of f.participants.slice(2, 4)) await f.command(c, { type: "game.submitDescription", payload: { text: "PK" } });
        await f.advance();
        await f.command(f.participants[4], { type: "game.submitVote", payload: { targetId: f.participants[2].record.playerId! } });
      }
    } else if (phase === "night") {
      for (const c of f.participants) await f.command(c, { type: "game.submitVote", payload: { targetId: "abstain" } });
      await f.advance();
      await f.command(f.participants[2], { type: "game.submitNightAction", payload: {} });
    } else if (phase === "voting") {
      await f.command(f.participants[2], { type: "game.submitVote", payload: { targetId: f.participants[3].record.playerId! } });
    }
    const room = (f.service as unknown as { rooms: Map<string, RoomRecord> }).rooms.get("8920")!;
    const original = { phase: room.round!.phase, mode: room.round!.speechMode, tieBreak: structuredClone(room.round!.tieBreak), votes: structuredClone(room.round!.votes), actions: structuredClone(room.round!.nightActions) };
    await f.startTimer(); f.advanceTime(10_000);
    await f.command(f.blank, { type: "game.enterBlankGuess", payload: {} });
    await f.command(f.blank, { type: "game.submitBlankGuess", payload: { words: ["西瓜", "菠萝"] } });
    await f.command(f.questioner, { type: "game.reviewBlankGuess", payload: { approve: false } });
    expect(room.round!.phase).toBe(original.phase);
    expect(room.round!.speechMode).toBe(original.mode);
    expect(room.round!.tieBreak).toEqual(original.tieBreak);
    expect(room.round!.votes).toEqual(original.votes);
    expect(room.round!.nightActions).toEqual(original.actions);
    expect(room.round!.phaseTimer?.durationSeconds).toBe(50);
    expect(room.round!.phaseTimer?.speechMode).toBe(original.mode);
    await f.command(f.questioner, { type: "game.stopPhaseTimer", payload: {} });
  });
}

for (const phase of ["description", "supplement", "tieBreak"] as const) {
  test(`${phase}到期记录缺席作者的最小身份、顺序和轮次`, async () => {
    const f = await setupRound();
    const victim = f.participants[2].record.playerId!;
    if (phase !== "description") { await f.describeAll(); await f.advance(); }
    if (phase === "supplement") await f.command(f.questioner, { type: "game.requestSupplement", payload: { playerIds: [victim] } });
    if (phase === "tieBreak") {
      for (const [i, c] of f.participants.entries()) await f.command(c, { type: "game.submitVote", payload: { targetId: f.participants[[0, 1, 3, 4].includes(i) ? 2 : 3].record.playerId! } });
      await f.advance();
    }
    const room = (f.service as unknown as { rooms: Map<string, RoomRecord> }).rooms.get("8920")!;
    // 仅在隔离测试里模拟运行时名册缺席，锁定已有超时占位作者契约。
    delete room.players[victim];
    await f.startTimer(); f.advanceTime(60_001); await f.service.runHousekeeping();
    const kind = phase === "description" ? "description" : phase;
    const description = room.round!.descriptions.filter((d) => d.playerId === victim && d.kind === kind).at(-1)!;
    expect(description.playerName).toBe("超时玩家");
    expect(description.text).toBe("（超时未发言）");
    expect(description.order).toBeGreaterThan(0);
    expect(description.cycle).toBe(1);
  });
}


test("局内直接换房产生旧席位待决，新房断线仍按空房宽限回收", async () => {
  const f = await setupRound(); const moving = f.participants[2];
  const playerId = moving.record.playerId!;
  await f.command(moving, { type: "room.create", payload: { roomId: "8921", name: "换房", userName: "玩家", visibility: "public", allowSpectators: true } });
  expect(f.snapshot().players.find((p) => p.id === playerId)?.online).toBe(false);
  expect(f.snapshot().status.pendingDisconnectPlayerId).toBe(playerId);
  await f.service.unregisterConnection(moving.record.id);
  f.advanceTime(90_001); await f.service.runHousekeeping();
  expect(f.service.getRoomSummaries().map((room) => room.roomId)).toEqual(["8920"]);
});

test("补充超时恢复投票后清理已投票离线者的过期待决", async () => {
  const f = await setupRound(); await f.describeAll(); await f.advance();
  const c = f.participants[2]; const playerId = c.record.playerId!;
  await f.command(c, { type: "game.submitVote", payload: { targetId: f.participants[3].record.playerId! } });
  await f.command(f.questioner, { type: "game.requestSupplement", payload: { playerIds: [playerId] } });
  await f.startTimer();
  await f.service.unregisterConnection(c.record.id);
  expect(f.snapshot().status.pendingDisconnectPlayerId).toBe(playerId);
  f.advanceTime(60_001); await f.service.runHousekeeping();
  expect(f.snapshot().status.phase).toBe("voting");
  expect(f.snapshot().status.pendingDisconnectPlayerId).toBeUndefined();
  expect(f.snapshot().status.phaseTimer).toBeUndefined();
});

test("强移除最后补充者恢复投票且撤销补充计时器", async () => {
  const f = await setupRound(); await f.describeAll(); await f.advance();
  const c = f.participants[2]; const playerId = c.record.playerId!;
  await f.command(f.questioner, { type: "game.requestSupplement", payload: { playerIds: [playerId] } });
  await f.startTimer(); await f.service.unregisterConnection(c.record.id);
  await f.command(f.questioner, { type: "game.resolveDisconnect", payload: { playerId, resolution: "eliminate" } });
  expect(f.snapshot().status.phase).toBe("voting");
  expect(f.snapshot().status.supplementIndex).toBeUndefined();
  expect(f.snapshot().status.phaseTimer).toBeUndefined();
  expect(f.snapshot().status.pendingDisconnectPlayerId).toBeUndefined();
});

test("在线白板及待裁定当前没有自动截止，手动计时可取消，掉线等待仍强制兜底", async () => {
  const f = await setupRound();
  await f.command(f.blank, { type: "game.enterBlankGuess", payload: {} });
  expect(f.snapshot().status.phaseTimer).toBeUndefined();
  f.advanceTime(120_000);
  await f.command(f.questioner, { type: "chat.send", payload: { text: "保持房间活动" } });
  await f.service.runHousekeeping();
  expect(f.snapshot().status.phase).toBe("blankGuess");
  await f.command(f.blank, { type: "game.submitBlankGuess", payload: { words: ["西瓜", "菠萝"] } });
  expect(f.snapshot().status.blankGuessPendingReview).toBe(true);
  expect(f.snapshot().status.phaseTimer).toBeUndefined();
  await f.startTimer(); await f.command(f.questioner, { type: "game.stopPhaseTimer", payload: {} });
  f.advanceTime(60_001); await f.service.runHousekeeping();
  expect(f.snapshot().status.blankGuessPendingReview).toBe(true);
  const playerId = f.blank.record.playerId!;
  await f.service.unregisterConnection(f.blank.record.id);
  await f.command(f.questioner, { type: "game.resolveDisconnect", payload: { playerId, resolution: "wait" } });
  expect(f.snapshot().status.phaseTimer?.durationSeconds).toBe(60);
  f.advanceTime(60_001); await f.service.runHousekeeping();
  expect(f.snapshot().status.phase).toBe("description");
  expect(f.snapshot().status.blankGuessPendingReview).toBeUndefined();
});


test("并发同号建房与同名加入只有一次成功，失败者保持原会话", async () => {
  const { service } = createTestContext();
  const a = createConnection(service, "concurrent-a"); const b = createConnection(service, "concurrent-b");
  for (const [i, c] of [a, b].entries()) await execute(service, c, { id: `old-${i}`, type: "room.create", payload: { roomId: `893${i}`, name: "旧房", userName: "房主", visibility: "public", allowSpectators: true } });
  const outcomes = await Promise.allSettled([a, b].map((c) => execute(service, c, { id: `create-${c.record.id}`, type: "room.create", payload: { roomId: "8932", name: "抢房", userName: "房主", visibility: "public", allowSpectators: true } })));
  expect(outcomes.filter((result) => result.status === "fulfilled")).toHaveLength(1);
  expect(outcomes.filter((result) => result.status === "rejected")).toHaveLength(1);
  const failedIndex = outcomes.findIndex((result) => result.status === "rejected");
  expect([a, b][failedIndex].record.roomId).toBe(`893${failedIndex}`);
  const c = createConnection(service, "concurrent-c"); const d = createConnection(service, "concurrent-d");
  const joins = await Promise.allSettled([c, d].map((c) => execute(service, c, { id: `join-${c.record.id}`, type: "room.join", roomId: "8932", payload: { userName: "重名" } })));
  expect(joins.filter((result) => result.status === "fulfilled")).toHaveLength(1);
  expect(joins.filter((result) => result.status === "rejected")).toHaveLength(1);
  expect(service.getHealthSnapshot().onlinePlayerCount).toBe(3);
});

test("猜词打断期间移除最后补充者只修改恢复目标，不逃逸猜词及裁定计时", async () => {
  const f = await setupRound(); await f.describeAll(); await f.advance();
  const c = f.participants[2]; const playerId = c.record.playerId!;
  await f.command(f.questioner, { type: "game.requestSupplement", payload: { playerIds: [playerId] } });
  await f.startTimer();
  await f.command(f.blank, { type: "game.enterBlankGuess", payload: {} });
  await f.startTimer();
  const timer = f.snapshot().status.phaseTimer;
  await f.service.unregisterConnection(c.record.id);
  await f.command(f.questioner, { type: "room.kick", payload: { playerId } });
  expect(f.snapshot().status.phase).toBe("blankGuess");
  expect(f.snapshot().status.phaseTimer).toEqual(timer);
  await f.command(f.blank, { type: "game.submitBlankGuess", payload: { words: ["西瓜", "菠萝"] } });
  await f.command(f.questioner, { type: "game.reviewBlankGuess", payload: { approve: false } });
  expect(f.snapshot().status.phase).toBe("voting");
  expect(f.snapshot().status.supplementIndex).toBeUndefined();
  expect(f.snapshot().status.phaseTimer).toBeUndefined();
});
