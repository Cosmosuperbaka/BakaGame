import { describe, expect, test } from "bun:test";
import type { WhoIsFakerRoomRecord } from "../../src/shared/Index";
import {
  codeOf,
  connect,
  createWorld,
  joinAs,
  makeRoom,
  send,
  startRound,
  type Seat,
  type World,
} from "./FacadeKit";

type Started = Awaited<ReturnType<typeof startRound>>;

const round = (world: World, id: string) => world.room(id).round!;

/** 命令前拨动时钟，命令后房间的「最近活跃」必须等于当前时刻。 */
const expectTouched = async (world: World, roomId: string, run: () => Promise<unknown>) => {
  world.advance(1_000);
  await run();
  expect(world.room(roomId).lastActivityAt).toBe(world.now());
};

const describe1 = (world: World, seat: Seat, text: string) =>
  send(world, seat.conn, {
    id: `d-${seat.id}-${text}`,
    type: "game.submitDescription",
    payload: { text },
  });

/** 房内所有发言者各说一句，回到「描述完成、等出题人推进」。 */
const everyoneDescribes = async (world: World, started: Started) => {
  for (const seat of started.speakers) await describe1(world, seat, `${seat.id}的话`);
};

describe("指派出题人细节", () => {
  const prepare = async (world: World, roomId: string, players: number) => {
    const host = await makeRoom(world, roomId);
    const others: Seat[] = [];
    for (let i = 0; i < players; i += 1) others.push(await joinAs(world, roomId, `玩家${i + 1}`));
    for (const seat of [host, ...others]) {
      await send(world, seat.conn, {
        id: `r${seat.id}`,
        type: "player.setReady",
        payload: { ready: true },
      });
    }
    return { host, others };
  };
  const assign = (world: World, host: Seat, playerId: string) =>
    send(world, host.conn, { id: "assign", type: "game.assignQuestioner", payload: { playerId } });

  test("目标不存在、离线或已被移出都拒绝；成功后写阶段、刷新活跃并返回出题人", async () => {
    const world = createWorld();
    const { host, others } = await prepare(world, "8001", 4);
    await send(world, host.conn, { id: "start", type: "game.advancePhase", payload: {} });
    expect(await codeOf(assign(world, host, "ghost"))).toBe("PLAYER_NOT_FOUND");
    await world.service.unregisterConnection(others[0].conn.record.id);
    expect(await codeOf(assign(world, host, others[0].id))).toBe("PLAYER_NOT_FOUND");
    expect(world.room("8001").round?.phase).toBe("assigningQuestioner");
    await expectTouched(world, "8001", async () => {
      expect(await assign(world, host, others[1].id)).toEqual({ questionerPlayerId: others[1].id });
    });
    expect(round(world, "8001").questionerPlayerId).toBe(others[1].id);
    expect(round(world, "8001").phase).toBe("wordSubmission");
  });

  test("被移出的成员不能被指派", async () => {
    const world = createWorld();
    const host = await makeRoom(world, "8002");
    const others: Seat[] = [];
    for (let i = 0; i < 5; i += 1) others.push(await joinAs(world, "8002", `玩家${i + 1}`));
    await send(world, host.conn, {
      id: "k",
      type: "room.kick",
      payload: { playerId: others[4].id },
    });
    for (const seat of [host, ...others.slice(0, 4)]) {
      await send(world, seat.conn, {
        id: `r${seat.id}`,
        type: "player.setReady",
        payload: { ready: true },
      });
    }
    await send(world, host.conn, { id: "start", type: "game.advancePhase", payload: {} });
    expect(await codeOf(assign(world, host, others[4].id))).toBe("PLAYER_NOT_FOUND");
    // 仍标着在线的被移出记录同样不能被指派：成员身份判定独立于在线判定
    world.room("8002").players[others[4].id].online = true;
    expect(await codeOf(assign(world, host, others[4].id))).toBe("PLAYER_NOT_FOUND");
  });

  test("指派时清掉遗留的阶段计时与发言模式", async () => {
    const world = createWorld();
    const { host, others } = await prepare(world, "8005", 4);
    await send(world, host.conn, { id: "start", type: "game.advancePhase", payload: {} });
    const r = round(world, "8005");
    r.phaseTimer = {
      durationSeconds: 60,
      endsAt: world.now() + 60_000,
      phase: "assigningQuestioner",
    };
    r.speechMode = "normal";
    await assign(world, host, others[0].id);
    expect(r.phaseTimer).toBeUndefined();
    expect(r.speechMode).toBeUndefined();
  });

  test("正式玩家出题时卧底数被夹到扣掉自身后的上限", async () => {
    const world = createWorld();
    const { host, others } = await prepare(world, "8003", 4);
    // 一名在线旁观者：配置可参照的人数是全部 5 名正式玩家，上限 2 个卧底
    const watcher = await joinAs(world, "8003", "旁观");
    await send(world, watcher.conn, {
      id: "w",
      type: "player.setSpectator",
      payload: { spectator: true },
    });
    await send(world, host.conn, {
      id: "u",
      type: "room.updateSettings",
      payload: { roleConfig: { undercoverCount: 2, hasAngel: false, hasBlank: false } },
    });
    expect(world.room("8003").settings.roleConfig.undercoverCount).toBe(2);
    await send(world, host.conn, { id: "start", type: "game.advancePhase", payload: {} });
    await assign(world, host, others[0].id);
    expect(world.room("8003").settings.roleConfig.undercoverCount).toBe(1);
  });

  test("旁观者出题：正式玩家全员参战，卧底数不被夹", async () => {
    const world = createWorld();
    const { host } = await prepare(world, "8004", 4);
    const watcher = await joinAs(world, "8004", "旁观");
    await send(world, watcher.conn, {
      id: "w",
      type: "player.setSpectator",
      payload: { spectator: true },
    });
    await send(world, host.conn, {
      id: "u",
      type: "room.updateSettings",
      payload: { roleConfig: { undercoverCount: 2, hasAngel: false, hasBlank: false } },
    });
    await send(world, host.conn, { id: "start", type: "game.advancePhase", payload: {} });
    await assign(world, host, watcher.id);
    expect(world.room("8004").settings.roleConfig.undercoverCount).toBe(2);
    expect(round(world, "8004").questionerPlayerId).toBe(watcher.id);
  });
});

describe("提交词语细节", () => {
  const setupWords = async (world: World, roomId: string, players: number) => {
    const host = await makeRoom(world, roomId);
    const others: Seat[] = [];
    for (let i = 0; i < players; i += 1) others.push(await joinAs(world, roomId, `玩家${i + 1}`));
    for (const seat of [host, ...others]) {
      await send(world, seat.conn, {
        id: `r${seat.id}`,
        type: "player.setReady",
        payload: { ready: true },
      });
    }
    await send(world, host.conn, { id: "start", type: "game.advancePhase", payload: {} });
    const questioner = others[others.length - 1];
    await send(world, host.conn, {
      id: "assign",
      type: "game.assignQuestioner",
      payload: { playerId: questioner.id },
    });
    return { host, others, questioner };
  };

  test("写入全部回合字段、刷新活跃、词库保存失败只记错误日志", async () => {
    const saved: Array<[string, string]> = [];
    const world = createWorld({
      wordBankRepository: {
        savePair: async (pair: [string, string]) => {
          saved.push(pair);
          throw new Error("写库失败");
        },
        drainWrites: async () => {},
      } as never,
    });
    const { questioner } = await setupWords(world, "8101", 4);
    round(world, "8101").phaseTimer = {
      durationSeconds: 60,
      endsAt: world.now() + 60_000,
      phase: "wordSubmission",
    };
    await expectTouched(world, "8101", async () => {
      expect(
        await send(world, questioner.conn, {
          id: "w",
          type: "game.submitWords",
          payload: { words: ["苹果", "香蕉"] },
        })
      ).toEqual({ phase: "description" });
    });
    const r = round(world, "8101");
    expect(r.phase).toBe("description");
    expect(r.speechMode).toBe("normal");
    expect(r.descriptionCycle).toBe(1);
    expect(r.descriptionOrder?.length).toBe(4);
    expect(r.descriptionSubmittedBy).toEqual([]);
    expect(r.votes).toEqual([]);
    expect(r.history).toEqual([]);
    expect(r.nightActions).toEqual([]);
    expect(r.words?.pair).toBeDefined();
    expect(r.phaseTimer).toBeUndefined();
    await Promise.resolve();
    await Promise.resolve();
    expect(saved).toEqual([["苹果", "香蕉"]]);
    expect(world.errors).toContain("词库异步保存失败");
  });

  test("白板开启时必须填写提示；提示按规范化写入", async () => {
    const world = createWorld();
    const { host, questioner } = await (async () => {
      const w = await setupWords(world, "8102", 8);
      return w;
    })();
    // 配置要在指派之前改好：此处只验证提交阶段的判定，所以直接写配置
    world.room("8102").settings.roleConfig = {
      undercoverCount: 1,
      hasAngel: false,
      hasBlank: true,
    };
    expect(
      await codeOf(
        send(world, questioner.conn, {
          id: "w1",
          type: "game.submitWords",
          payload: { words: ["苹果", "香蕉"] },
        })
      )
    ).toBe("BLANK_HINT_REQUIRED");
    await send(world, questioner.conn, {
      id: "w2",
      type: "game.submitWords",
      payload: { words: ["苹果", "香蕉"], blankHint: "  水果  " },
    });
    expect(round(world, "8102").words?.blankHint).toBe("水果");
    expect(host.id).toBeTruthy();
  });

  test("测试房单人：房主既是出题人又是参赛者，出题人被清空；非测试房没有参赛者被拒", async () => {
    const world = createWorld();
    const host = await makeRoom(world, "Oblivionis");
    await send(world, host.conn, { id: "b", type: "test.addBot", payload: { count: 4 } });
    await send(world, host.conn, {
      id: "j",
      type: "test.jumpToPhase",
      payload: { phase: "wordSubmission" },
    });
    // 机器人都改成旁观，只剩房主一名正式玩家
    for (const player of Object.values(world.room("Oblivionis").players)) {
      if (player.id !== host.id) player.membership = "spectator";
    }
    round(world, "Oblivionis").questionerPlayerId = host.id;
    world.room("Oblivionis").settings.roleConfig = {
      undercoverCount: 1,
      hasAngel: false,
      hasBlank: false,
    };
    // 单人测试房把房主当作唯一参赛者（走到配置校验才失败），而不是「没有参赛者」；
    // 出题人在校验之前就被清空，被拒的请求也留下这个改动（现状行为，由用例钉住）
    expect(
      await codeOf(
        send(world, host.conn, {
          id: "w",
          type: "game.submitWords",
          payload: { words: ["苹果", "香蕉"] },
        })
      )
    ).toBe("INVALID_ROLE_CONFIG");
    expect(round(world, "Oblivionis").questionerPlayerId).toBeUndefined();

    // 非测试房：出题人是唯一的正式玩家（其余都是旁观者），没有人可参赛
    const world2 = createWorld();
    const started = await startRound(world2, "8103");
    const room = world2.room("8103");
    round(world2, "8103").phase = "wordSubmission";
    for (const seat of [started.host, ...started.others.slice(0, -1)]) {
      room.players[seat.id].membership = "spectator";
    }
    expect(
      await codeOf(
        send(world2, started.questioner.conn, {
          id: "w",
          type: "game.submitWords",
          payload: { words: ["苹果", "香蕉"] },
        })
      )
    ).toBe("INSUFFICIENT_PLAYERS");
  });

  test("重新出词会清掉上一轮遗留的发言、投票、历史与夜晚（测试房跳回出词阶段）", async () => {
    const world = createWorld();
    const host = await makeRoom(world, "Oblivionis");
    await send(world, host.conn, { id: "b", type: "test.addBot", payload: { count: 4 } });
    await send(world, host.conn, {
      id: "j",
      type: "test.jumpToPhase",
      payload: { phase: "wordSubmission" },
    });
    await send(world, host.conn, {
      id: "w",
      type: "game.submitWords",
      payload: { words: ["苹果", "香蕉"] },
    });
    const r = round(world, "Oblivionis");
    r.descriptionSubmittedBy = ["x"];
    r.votes = [{ voterId: "a", targetId: "b" }] as never;
    r.voteHistory = [{ day: 1, votes: [] }] as never;
    r.history = [{ kind: "vote" }] as never;
    r.tieBreak = { candidateIds: [], stage: "vote", descriptionsDone: [], votes: [] } as never;
    r.nightActions = [{ actorId: "a", actorRole: "civilian" }] as never;
    r.blankGuessContext = { stub: true } as never;
    r.phase = "wordSubmission";
    r.speechMode = undefined;
    r.descriptionCycle = 5;
    await send(world, host.conn, {
      id: "w2",
      type: "game.submitWords",
      payload: { words: ["苹果", "香蕉"] },
    });
    const after = round(world, "Oblivionis");
    expect(after.descriptionCycle).toBe(1);
    expect(after.speechMode).toBe("normal");
    expect(after.votes).toEqual([]);
    expect(after.voteHistory).toEqual([]);
    expect(after.history).toEqual([]);
    expect(after.tieBreak).toBeUndefined();
    expect(after.nightActions).toEqual([]);
    expect(after.blankGuessContext).toBeUndefined();
    expect(after.descriptionSubmittedBy.length).toBeLessThanOrEqual(4);
    expect(after.descriptionSubmittedBy).not.toContain("x");
  });
});

describe("发言细节", () => {
  test("普通发言：存活、重复、顺位与刷新活跃、日志", async () => {
    const world = createWorld();
    const started = await startRound(world, "8201");
    const [a, b] = started.speakers;
    round(world, "8201").assignments[b.id].alive = false;
    expect(await codeOf(describe1(world, b, "x"))).toBe("ACTION_FORBIDDEN");
    await expectTouched(world, "8201", () => describe1(world, a, "我的话"));
    expect(await codeOf(describe1(world, a, "again"))).toBe("ALREADY_SUBMITTED");
    const r = round(world, "8201");
    const last = r.descriptions.at(-1)!;
    expect(last.kind).toBe("description");
    expect(last.order).toBe((r.descriptionOrder ?? []).indexOf(a.id) + 1);
    expect(world.logs("game.description_submitted").at(-1)?.playerId).toBe(a.id);
  });

  test("补充发言：只认被点名且未补过的人；顺位取点名表；补齐后切回原阶段", async () => {
    const world = createWorld();
    const started = await startRound(world, "8202");
    const [a, b, c] = started.speakers;
    await everyoneDescribes(world, started);
    const r = round(world, "8202");
    r.supplement = {
      index: 1,
      requestedPlayerIds: [a.id, b.id],
      donePlayers: [],
      resumePhase: "voting",
    };
    r.phase = "description";
    r.speechMode = "supplement";
    // 未被点名的人不能走补充分支
    expect(await codeOf(describe1(world, c, "旁话"))).toBe("INVALID_PHASE");
    await describe1(world, b, "补充乙");
    const supplementEntry = r.descriptions.find(
      (d) => d.playerId === b.id && d.kind === "supplement"
    )!;
    expect(supplementEntry.order).toBe(1 + [a.id, b.id].indexOf(b.id));
    expect(supplementEntry.supplementIndex).toBe(1);
    // 已补过的人再发：不再是被点名未补的人 → 阶段不对
    expect(await codeOf(describe1(world, b, "再补"))).toBe("INVALID_PHASE");
    // 补充者已出局：拒绝
    r.assignments[a.id].alive = false;
    expect(await codeOf(describe1(world, a, "出局者"))).toBe("ACTION_FORBIDDEN");
    // 阶段不在描述：拒绝
    r.assignments[a.id].alive = true;
    r.phase = "voting";
    expect(await codeOf(describe1(world, a, "投票阶段补充"))).toBe("ACTION_FORBIDDEN");
  });

  test("平票发言：阶段、候选、重复、发言模式写入顺序与顺位", async () => {
    const world = createWorld();
    const started = await startRound(world, "8203");
    const [a, b, c] = started.speakers;
    const r = round(world, "8203");
    r.phase = "tieBreak";
    r.speechMode = "normal";
    r.tieBreakCount = 2;
    r.tieBreak = { candidateIds: [a.id, b.id], stage: "vote", descriptionsDone: [], votes: [] };
    expect(await codeOf(describe1(world, a, "x"))).toBe("INVALID_PHASE");
    r.tieBreak.stage = "description";
    // 先写发言模式、再判候选：被拒的请求同样把模式改成平票（现状行为，由用例钉住）
    expect(await codeOf(describe1(world, c, "非候选"))).toBe("ACTION_FORBIDDEN");
    expect(r.speechMode as string).toBe("tieBreak");
    r.speechMode = "normal";
    await describe1(world, b, "平票乙");
    expect(r.speechMode as string).toBe("tieBreak");
    const entry = r.descriptions.at(-1)!;
    expect(entry.kind).toBe("tieBreak");
    expect(entry.order).toBe(2);
    expect(entry.tieBreakIndex).toBe(2);
    expect(await codeOf(describe1(world, b, "再说"))).toBe("ALREADY_SUBMITTED");
  });
});

describe("投票与夜晚细节", () => {
  test("投票：写票、平票阶段资格、日志标记、撤票幂等", async () => {
    const world = createWorld();
    const started = await startRound(world, "8301");
    const [a, b, c] = started.speakers;
    const r = round(world, "8301");
    r.phase = "voting";
    r.speechMode = undefined;
    const vote = (seat: Seat, targetId: string) =>
      send(world, seat.conn, {
        id: `v-${seat.id}-${targetId}`,
        type: "game.submitVote",
        payload: { targetId },
      });
    await expectTouched(world, "8301", () => vote(a, b.id));
    expect(r.votes.map((v) => [v.voterId, v.targetId])).toEqual([[a.id, b.id]]);
    expect(world.logs("game.vote_submitted").at(-1)?.payload).toEqual({
      targetId: b.id,
      tieBreak: false,
    });
    expect(await send(world, a.conn, { id: "c1", type: "game.cancelVote", payload: {} })).toEqual({
      cancelled: true,
    });
    expect(await send(world, a.conn, { id: "c2", type: "game.cancelVote", payload: {} })).toEqual({
      cancelled: false,
    });
    expect(r.votes).toEqual([]);
    await expectTouched(world, "8301", () =>
      send(world, a.conn, { id: "c3", type: "game.cancelVote", payload: {} })
    );

    r.phase = "tieBreak";
    r.tieBreak = {
      candidateIds: [a.id, b.id],
      stage: "description",
      descriptionsDone: [],
      votes: [],
    };
    expect(await codeOf(vote(c, a.id))).toBe("INVALID_PHASE");
    expect(
      await codeOf(send(world, c.conn, { id: "cc", type: "game.cancelVote", payload: {} }))
    ).toBe("INVALID_PHASE");
    r.tieBreak.stage = "vote";
    // 平票投票只能投候选人
    expect(
      await codeOf(
        vote(c, started.host.id === c.id ? b.id : started.host.id === a.id ? c.id : c.id)
      )
    ).toBeDefined();
    await vote(c, a.id);
    expect(r.tieBreak.votes.map((v) => [v.voterId, v.targetId])).toEqual([[c.id, a.id]]);
    expect(world.logs("game.vote_submitted").at(-1)?.payload).toEqual({
      targetId: a.id,
      tieBreak: true,
    });
    expect(await send(world, c.conn, { id: "c4", type: "game.cancelVote", payload: {} })).toEqual({
      cancelled: true,
    });
    expect(await send(world, c.conn, { id: "c5", type: "game.cancelVote", payload: {} })).toEqual({
      cancelled: false,
    });
    expect(r.tieBreak.votes).toEqual([]);
  });

  test("平票投票的资格：投给非候选人被拒且不落票", async () => {
    const world = createWorld();
    const started = await startRound(world, "8302");
    const [a, b, c, d] = started.speakers;
    const r = round(world, "8302");
    r.phase = "tieBreak";
    r.tieBreak = { candidateIds: [a.id, b.id], stage: "vote", descriptionsDone: [], votes: [] };
    expect(
      await codeOf(
        send(world, c.conn, { id: "v", type: "game.submitVote", payload: { targetId: d.id } })
      )
    ).toBeDefined();
    expect(r.tieBreak.votes).toEqual([]);
  });

  test("夜晚行动：资格、目标、写入、撤销与日志", async () => {
    const world = createWorld();
    const started = await startRound(world, "8303");
    const [a, b, c] = started.speakers;
    const r = round(world, "8303");
    r.phase = "night";
    r.speechMode = undefined;
    r.assignments[a.id].role = "civilian";
    r.assignments[b.id].role = "undercover";
    r.assignments[c.id].role = "blank";
    const night = (seat: Seat, targetId?: string | null) =>
      send(world, seat.conn, {
        id: `n-${seat.id}`,
        type: "game.submitNightAction",
        payload: { targetId },
      });
    expect(await codeOf(night(c, b.id))).toBe("ACTION_FORBIDDEN");
    r.assignments[a.id].alive = false;
    expect(await codeOf(night(a, b.id))).toBe("ACTION_FORBIDDEN");
    r.assignments[a.id].alive = true;
    r.assignments[c.id].alive = false;
    expect(await codeOf(night(b, c.id))).toBe("INVALID_TARGET");
    r.assignments[c.id].alive = true;
    expect(await codeOf(night(b, b.id))).toBe("INVALID_TARGET");
    await expectTouched(world, "8303", () => night(b, a.id));
    expect(r.nightActions.map((n) => [n.actorId, n.targetId])).toEqual([[b.id, a.id]]);
    expect(world.logs("game.night_action_submitted").at(-1)?.payload).toEqual({ hasTarget: true });
    await night(b, null);
    expect(r.nightActions.map((n) => [n.actorId, n.targetId])).toEqual([[b.id, undefined]]);
    expect(world.logs("game.night_action_submitted").at(-1)?.payload).toEqual({ hasTarget: false });
    expect(
      await send(world, b.conn, { id: "x1", type: "game.cancelNightAction", payload: {} })
    ).toEqual({ cancelled: true });
    expect(
      await send(world, b.conn, { id: "x2", type: "game.cancelNightAction", payload: {} })
    ).toEqual({ cancelled: false });
    await expectTouched(world, "8303", () =>
      send(world, b.conn, { id: "x3", type: "game.cancelNightAction", payload: {} })
    );
  });
});

describe("补充请求细节", () => {
  test("前置判定、次数递增、去重、清计时与刷新活跃", async () => {
    const world = createWorld();
    const started = await startRound(world, "8401");
    const [a, b] = started.speakers;
    const request = (ids: string[]) =>
      send(world, started.questioner.conn, {
        id: "rs",
        type: "game.requestSupplement",
        payload: { playerIds: ids },
      });
    expect(await codeOf(request([a.id]))).toBe("PHASE_INCOMPLETE");
    await everyoneDescribes(world, started);
    const r = round(world, "8401");
    expect(await codeOf(request(["ghost"]))).toBe("INVALID_MESSAGE");
    r.assignments[b.id].alive = false;
    expect(await codeOf(request([b.id]))).toBe("INVALID_MESSAGE");
    r.assignments[b.id].alive = true;
    expect(await codeOf(request([]))).toBeDefined();
    // 已有历史补充：次数取已有最大加一
    r.descriptions.push({ ...r.descriptions[0], kind: "supplement", supplementIndex: 3 } as never);
    // 计时先挂上，请求后应被清掉
    await send(world, started.questioner.conn, {
      id: "t",
      type: "game.startPhaseTimer",
      payload: { durationSeconds: 60 },
    });
    expect(r.phaseTimer).toBeDefined();
    await expectTouched(world, "8401", async () => {
      expect(await request([a.id, a.id, b.id])).toEqual({ requested: true });
    });
    expect(r.supplement).toMatchObject({
      index: 4,
      requestedPlayerIds: [a.id, b.id],
      donePlayers: [],
    });
    expect(r.phaseTimer).toBeUndefined();
    expect(r.phase).toBe("description");
    expect(r.speechMode).toBe("supplement");
    r.phase = "voting";
    r.speechMode = undefined;
    expect(await codeOf(request([a.id]))).toBe("ACTION_FORBIDDEN");
  });
});

describe("掉线决策队列与机器人", () => {
  test("点名补充发言时，离线的被点名者进入掉线决策队列", async () => {
    const world = createWorld();
    const started = await startRound(world, "8402");
    const [a, b] = started.speakers;
    await everyoneDescribes(world, started);
    await world.service.unregisterConnection(b.conn.record.id);
    expect(round(world, "8402").pendingDisconnectPlayerIds ?? []).not.toContain(b.id);
    await send(world, started.questioner.conn, {
      id: "rs",
      type: "game.requestSupplement",
      payload: { playerIds: [a.id, b.id] },
    });
    expect(round(world, "8402").pendingDisconnectPlayerIds).toContain(b.id);
  });

  test("补充发言补齐后回到投票：离线且没投票的人进入掉线决策队列", async () => {
    const world = createWorld();
    const started = await startRound(world, "8403");
    const [a, b] = started.speakers;
    await everyoneDescribes(world, started);
    const r = round(world, "8403");
    r.supplement = { index: 1, requestedPlayerIds: [a.id], donePlayers: [], resumePhase: "voting" };
    r.speechMode = "supplement";
    await world.service.unregisterConnection(b.conn.record.id);
    r.pendingDisconnectPlayerIds = [];
    await describe1(world, a, "补充甲");
    expect(r.phase).toBe("voting");
    expect(r.pendingDisconnectPlayerIds).toContain(b.id);
  });

  test("测试房：点名机器人补充后，机器人当场补完并回到原阶段", async () => {
    const world = createWorld();
    const host = await makeRoom(world, "Oblivionis");
    await send(world, host.conn, { id: "b", type: "test.addBot", payload: { count: 4 } });
    await send(world, host.conn, {
      id: "j",
      type: "test.jumpToPhase",
      payload: { phase: "description" },
    });
    const r = round(world, "Oblivionis");
    const bot = Object.values(world.room("Oblivionis").players).find((p) => p.isBot)!;
    r.questionerPlayerId = host.id;
    r.descriptionSubmittedBy.push(host.id);
    await send(world, host.conn, {
      id: "rs",
      type: "game.requestSupplement",
      payload: { playerIds: [bot.id] },
    });
    expect(r.supplement).toBeUndefined();
    expect(r.descriptions.some((d) => d.kind === "supplement" && d.playerId === bot.id)).toBe(true);
  });
});

describe("频道判定细节", () => {
  const speak = (world: World, seat: Seat, text: string) =>
    send(world, seat.conn, { id: `c-${seat.id}-${text}`, type: "chat.send", payload: { text } });

  test("亡者与旁观者进亡者频道并带角色标记；出题人旁观者与读不到的旁观者留在主频道", async () => {
    const world = createWorld();
    const started = await startRound(world, "8501");
    const [a] = started.speakers;
    const room: WhoIsFakerRoomRecord = world.room("8501");
    const lastChat = () => room.chat.at(-1)!;
    // 亡者
    round(world, "8501").assignments[a.id].alive = false;
    await speak(world, a, "亡者");
    expect(lastChat()).toMatchObject({ channel: "ghost", ghostRole: "dead" });
    round(world, "8501").assignments[a.id].alive = true;
    // 局中进房的旁观者：开关关闭时读不到亡者频道，不往里写
    const watcher = await joinAs(world, "8501", "旁观");
    await speak(world, watcher, "关着");
    expect(lastChat()).toMatchObject({ channel: "main" });
    room.settings.spectatorsSeeAnswers = true;
    await speak(world, watcher, "开着");
    expect(lastChat()).toMatchObject({ channel: "ghost", ghostRole: "spectator" });
    // 出题人即使是旁观成员也留在主频道
    room.players[started.questioner.id].membership = "spectator";
    await speak(world, started.questioner, "出题");
    expect(lastChat()).toMatchObject({ channel: "main" });
    expect(lastChat().system).toBe(false);
    expect(world.logs("chat.sent").at(-1)?.payload).toMatchObject({
      channel: "main",
      text: "出题",
    });
    // 活着的玩家主频道
    await speak(world, a, "活着");
    expect(lastChat()).toMatchObject({ channel: "main" });
    // 局外只有主频道
    round(world, "8501").phase = "gameOver";
    await speak(world, watcher, "结束后");
    expect(lastChat()).toMatchObject({ channel: "main" });
  });

  test("聊天按连接限流", async () => {
    const world = createWorld();
    const host = await makeRoom(world, "8502");
    let code: string | undefined;
    for (let i = 0; i < 30 && !code; i += 1) code = await codeOf(speak(world, host, `话${i}`));
    expect(code).toBeDefined();
    const other = connect(world, "x");
    expect(other.record.id).toBe("x");
  });
});
