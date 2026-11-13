import { describe, expect, test } from "bun:test";
import { ABSTAIN_TARGET_ID } from "../../src/shared/WhoIsFakerValues";
import {
  codeOf,
  createWorld,
  makeRoom,
  send,
  startRound,
  type Seat,
  type World,
} from "./FacadeKit";

const round = (world: World, id: string) => world.room(id).round!;
const TIMEOUT_TEXT = "（超时未发言）";

const startTimer = (world: World, seat: Seat) =>
  send(world, seat.conn, {
    id: `timer-${world.now()}`,
    type: "game.startPhaseTimer",
    payload: { durationSeconds: 60 },
  });

const expire = async (world: World) => {
  world.advance(60_000);
  await world.service.runHousekeeping();
};

const advance = (world: World, seat: Seat) =>
  send(world, seat.conn, { id: `adv-${world.now()}`, type: "game.advancePhase", payload: {} });

describe("超时与机器人补发言：记录的每个字段", () => {
  test("描述超时：按发言顺序补位，类型、轮次、顺位与「已提交」名单", async () => {
    const world = createWorld();
    const started = await startRound(world, "6001");
    const r = round(world, "6001");
    const first = started.speakers.find((s) => s.id === r.descriptionOrder[0])!;
    await send(world, first.conn, {
      id: "d",
      type: "game.submitDescription",
      payload: { text: "先说了" },
    });
    // 名册里已不存在的发言者：补位记录用占位名
    const ghostId = r.descriptionOrder[3];
    delete world.room("6001").players[ghostId];
    await startTimer(world, started.questioner);
    await expire(world);
    const filled = r.descriptions.filter((d) => d.text === TIMEOUT_TEXT);
    expect(filled.map((d) => d.playerId)).toEqual(r.descriptionOrder.slice(1));
    for (const entry of filled) {
      expect(entry.kind).toBe("description");
      expect(entry.cycle).toBe(1);
      expect(entry.order).toBe(r.descriptionOrder.indexOf(entry.playerId) + 1);
      expect(entry.supplementIndex).toBeUndefined();
      expect(entry.tieBreakIndex).toBeUndefined();
    }
    expect(filled.find((d) => d.playerId === ghostId)?.playerName).toBe("超时玩家");
    expect(filled.find((d) => d.playerId !== ghostId)?.playerName).not.toBe("超时玩家");
    expect([...r.descriptionSubmittedBy].sort()).toEqual([...r.descriptionOrder].sort());
  });

  test("补充发言超时：补位记录带补充次数与点名顺位，已完成名单补齐", async () => {
    const world = createWorld();
    const started = await startRound(world, "6002");
    const [a, b] = started.speakers;
    for (const seat of started.speakers) {
      await send(world, seat.conn, {
        id: `d${seat.id}`,
        type: "game.submitDescription",
        payload: { text: "话" },
      });
    }
    await send(world, started.questioner.conn, {
      id: "rs",
      type: "game.requestSupplement",
      payload: { playerIds: [b.id, a.id] },
    });
    const r = round(world, "6002");
    const index = r.supplement!.index;
    delete world.room("6002").players[a.id];
    await startTimer(world, started.questioner);
    await expire(world);
    const filled = r.descriptions.filter((d) => d.text === TIMEOUT_TEXT);
    expect(filled.map((d) => d.playerId)).toEqual([b.id, a.id]);
    expect(filled.map((d) => d.order)).toEqual([1, 2]);
    for (const entry of filled) {
      expect(entry.kind).toBe("supplement");
      expect(entry.supplementIndex).toBe(index);
      expect(entry.tieBreakIndex).toBeUndefined();
      expect(entry.cycle).toBe(1);
    }
    expect(filled[1].playerName).toBe("超时玩家");
    expect(r.supplement).toBeUndefined();
  });

  test("平票发言超时：补位记录带加赛次数与候选顺位，随后转入投票段", async () => {
    const world = createWorld();
    const started = await startRound(world, "6003");
    const [a, b, c] = started.speakers;
    const r = round(world, "6003");
    r.phase = "tieBreak";
    r.speechMode = "tieBreak";
    r.tieBreakCount = 2;
    r.tieBreak = {
      candidateIds: [b.id, a.id, c.id],
      stage: "description",
      descriptionsDone: [c.id],
      votes: [],
    };
    delete world.room("6003").players[a.id];
    await startTimer(world, started.questioner);
    await expire(world);
    const filled = r.descriptions.filter((d) => d.text === TIMEOUT_TEXT);
    expect(filled.map((d) => d.playerId)).toEqual([b.id, a.id]);
    expect(filled.map((d) => d.order)).toEqual([1, 2]);
    for (const entry of filled) {
      expect(entry.kind).toBe("tieBreak");
      expect(entry.tieBreakIndex).toBe(2);
      expect(entry.supplementIndex).toBeUndefined();
      expect(entry.cycle).toBe(1);
    }
    expect(filled[1].playerName).toBe("超时玩家");
    expect(r.tieBreak?.descriptionsDone).toEqual([c.id, b.id, a.id]);
    expect(r.tieBreak?.stage).toBe("vote");
  });

  test("机器人补发言：描述、补充、平票三种记录的类型、顺位与名单", async () => {
    const world = createWorld();
    const host = await makeRoom(world, "Oblivionis");
    await send(world, host.conn, { id: "b", type: "test.addBot", payload: { count: 4 } });
    await send(world, host.conn, {
      id: "j",
      type: "test.jumpToPhase",
      payload: { phase: "description" },
    });
    const room = world.room("Oblivionis");
    const r = room.round!;
    const bots = Object.values(room.players).filter((p) => p.isBot);
    const botEntries = r.descriptions.filter((d) => bots.some((b) => b.id === d.playerId));
    expect(botEntries).toHaveLength(4);
    for (const entry of botEntries) {
      expect(entry.kind).toBe("description");
      expect(entry.cycle).toBe(r.descriptionCycle);
      expect(entry.order).toBe(r.descriptionOrder.indexOf(entry.playerId) + 1);
      expect(entry.supplementIndex).toBeUndefined();
      expect(entry.tieBreakIndex).toBeUndefined();
    }
    expect(r.descriptionSubmittedBy.sort()).toEqual(bots.map((b) => b.id).sort());

    // 补充：房主当出题人，点名两个机器人
    r.questionerPlayerId = host.id;
    r.descriptionSubmittedBy.push(host.id);
    const [x, y] = bots;
    await send(world, host.conn, {
      id: "rs",
      type: "game.requestSupplement",
      payload: { playerIds: [y.id, x.id] },
    });
    const supplements = r.descriptions.filter((d) => d.kind === "supplement");
    // 机器人按名册顺序出手，顺位仍取点名表里的位置
    expect(supplements.map((d) => [d.playerId, d.order, d.supplementIndex])).toEqual([
      [x.id, 2, 1],
      [y.id, 1, 1],
    ]);
    expect(
      supplements.every((d) => d.tieBreakIndex === undefined && d.cycle === r.descriptionCycle)
    ).toBe(true);

    // 平票：候选是前两名存活者
    await send(world, host.conn, {
      id: "jt",
      type: "test.jumpToPhase",
      payload: { phase: "tieBreak" },
    });
    const tie = round(world, "Oblivionis");
    const candidates = tie.tieBreak!.candidateIds;
    const tieEntries = tie.descriptions.filter((d) => d.kind === "tieBreak");
    const botCandidates = candidates.filter((id) => bots.some((b) => b.id === id));
    expect(tieEntries.map((d) => d.playerId).sort()).toEqual([...botCandidates].sort());
    for (const entry of tieEntries) {
      expect(entry.tieBreakIndex).toBe(tie.tieBreakCount);
      expect(entry.order).toBe(candidates.indexOf(entry.playerId) + 1);
      expect(entry.supplementIndex).toBeUndefined();
    }
    for (const id of botCandidates) expect(tie.tieBreak?.descriptionsDone).toContain(id);
  });
});

describe("「还在等谁」：推进判定、掉线队列、超时补位与机器人", () => {
  const offline = (world: World, seat: Seat) =>
    world.service.unregisterConnection(seat.conn.record.id);

  test("投票：有人没投就不能推进；投齐才能推进", async () => {
    const world = createWorld();
    const started = await startRound(world, "6101");
    const r = round(world, "6101");
    r.phase = "voting";
    r.speechMode = undefined;
    r.votes = [];
    const [a, b, c, d] = started.speakers;
    for (const seat of [a, b, c]) {
      await send(world, seat.conn, {
        id: `v${seat.id}`,
        type: "game.submitVote",
        payload: { targetId: d.id },
      });
    }
    expect(await codeOf(advance(world, started.questioner))).toBe("PHASE_INCOMPLETE");
    await send(world, d.conn, { id: "vd", type: "game.submitVote", payload: { targetId: a.id } });
    expect(await codeOf(advance(world, started.questioner))).toBeUndefined();
  });

  test("平票投票：候选人不用投票，其余存活者全投完才能推进；出局者不用投", async () => {
    const world = createWorld();
    const started = await startRound(world, "6102");
    const r = round(world, "6102");
    const [a, b, c, d] = started.speakers;
    r.phase = "tieBreak";
    r.speechMode = undefined;
    r.tieBreak = {
      candidateIds: [a.id, b.id],
      stage: "vote",
      descriptionsDone: [a.id, b.id],
      votes: [],
    };
    r.assignments[d.id].alive = false;
    expect(await codeOf(advance(world, started.questioner))).toBe("PHASE_INCOMPLETE");
    await send(world, c.conn, { id: "vc", type: "game.submitVote", payload: { targetId: a.id } });
    expect(await codeOf(advance(world, started.questioner))).toBeUndefined();
  });

  test("平票发言：存活候选没说完不能推进，出局的候选不必等", async () => {
    const world = createWorld();
    const started = await startRound(world, "6103");
    const r = round(world, "6103");
    const [a, b] = started.speakers;
    r.phase = "tieBreak";
    r.speechMode = "tieBreak";
    r.tieBreak = {
      candidateIds: [a.id, b.id],
      stage: "description",
      descriptionsDone: [],
      votes: [],
    };
    expect(await codeOf(advance(world, started.questioner))).toBe("PHASE_INCOMPLETE");
    r.tieBreak.descriptionsDone = [a.id];
    expect(await codeOf(advance(world, started.questioner))).toBe("PHASE_INCOMPLETE");
    r.assignments[b.id].alive = false;
    expect(await codeOf(advance(world, started.questioner))).toBeUndefined();
    expect(r.tieBreak.stage).toBe("vote");
  });

  test("夜晚：只等存活的平民与卧底；天使与白板、出局者不必等", async () => {
    const world = createWorld();
    const started = await startRound(world, "6104");
    const r = round(world, "6104");
    const [a, b, c, d] = started.speakers;
    r.phase = "night";
    r.speechMode = undefined;
    r.nightActions = [];
    r.assignments[a.id].role = "civilian";
    r.assignments[b.id].role = "undercover";
    r.assignments[c.id].role = "blank";
    r.assignments[d.id].role = "civilian";
    r.assignments[d.id].alive = false;
    expect(await codeOf(advance(world, started.questioner))).toBe("PHASE_INCOMPLETE");
    await send(world, a.conn, {
      id: "na",
      type: "game.submitNightAction",
      payload: { targetId: null },
    });
    expect(await codeOf(advance(world, started.questioner))).toBe("PHASE_INCOMPLETE");
    await send(world, b.conn, {
      id: "nb",
      type: "game.submitNightAction",
      payload: { targetId: null },
    });
    expect(await codeOf(advance(world, started.questioner))).toBeUndefined();
  });

  test("掉线队列：各阶段只有「本阶段还在等」的离线者入队", async () => {
    type Setup = (r: ReturnType<typeof round>, s: Seat[]) => void;
    const scenario = async (roomId: string, setup: Setup, who: number[]) => {
      const world = createWorld();
      const started = await startRound(world, roomId);
      const r = round(world, roomId);
      setup(r, started.speakers);
      const queued: number[] = [];
      for (const index of who) {
        r.pendingDisconnectPlayerIds = [];
        await offline(world, started.speakers[index]);
        if (r.pendingDisconnectPlayerIds.includes(started.speakers[index].id)) queued.push(index);
      }
      return queued;
    };
    // 描述：发过言的不等，没发的等
    expect(
      await scenario("6110", (r, s) => r.descriptionSubmittedBy.push(s[0].id), [0, 1])
    ).toEqual([1]);
    // 补充发言：只等被点名且没补的人
    expect(
      await scenario(
        "6111",
        (r, s) => {
          r.descriptionSubmittedBy.push(...s.map((x) => x.id));
          r.supplement = {
            index: 1,
            requestedPlayerIds: [s[0].id],
            donePlayers: [],
            resumePhase: "voting",
          };
          r.speechMode = "supplement";
        },
        [0, 1]
      )
    ).toEqual([0]);
    // 投票：没投的等
    expect(
      await scenario(
        "6112",
        (r, s) => {
          r.phase = "voting";
          r.speechMode = undefined;
          r.votes = [{ voterId: s[0].id, targetId: s[3].id }];
        },
        [0, 1]
      )
    ).toEqual([1]);
    // 平票发言：只等没说完的候选人
    expect(
      await scenario(
        "6113",
        (r, s) => {
          r.phase = "tieBreak";
          r.speechMode = "tieBreak";
          r.tieBreak = {
            candidateIds: [s[0].id, s[1].id],
            stage: "description",
            descriptionsDone: [s[0].id],
            votes: [],
          };
        },
        [0, 1, 2]
      )
    ).toEqual([1]);
    // 平票投票：候选人不用投票；已投的不等；其余没投的等
    expect(
      await scenario(
        "6114",
        (r, s) => {
          r.phase = "tieBreak";
          r.speechMode = undefined;
          r.tieBreak = {
            candidateIds: [s[0].id, s[1].id],
            stage: "vote",
            descriptionsDone: [s[0].id, s[1].id],
            votes: [{ voterId: s[2].id, targetId: s[0].id }],
          };
        },
        [0, 2, 3]
      )
    ).toEqual([3]);
    // 夜晚：只等平民与卧底，已行动的不等
    expect(
      await scenario(
        "6115",
        (r, s) => {
          r.phase = "night";
          r.speechMode = undefined;
          r.nightActions = [{ actorId: s[2].id, actorRole: "civilian" }];
          r.assignments[s[0].id].role = "civilian";
          r.assignments[s[1].id].role = "blank";
          r.assignments[s[2].id].role = "civilian";
          r.assignments[s[3].id].role = "undercover";
        },
        [0, 1, 2, 3]
      )
    ).toEqual([0, 3]);
    // 出局者不等
    expect(
      await scenario(
        "6116",
        (r, s) => {
          r.phase = "voting";
          r.speechMode = undefined;
          r.votes = [];
          r.assignments[s[1].id].alive = false;
        },
        [0, 1]
      )
    ).toEqual([0]);
  });

  test("投票超时：没投的存活者记弃权；平票投票超时连候选人也记弃权（现状）", async () => {
    const world = createWorld();
    const started = await startRound(world, "6106");
    const r = round(world, "6106");
    const [a, b, c, d] = started.speakers;
    r.phase = "voting";
    r.speechMode = undefined;
    r.votes = [{ voterId: a.id, targetId: b.id }];
    await startTimer(world, started.questioner);
    await expire(world);
    const history = r.voteHistory.at(-1)!;
    expect(history.tieBreak).toBeFalsy();
    const byVoter = Object.fromEntries(history.votes.map((v) => [v.voterId, v.targetId]));
    expect(byVoter[a.id]).toBe(b.id);
    for (const seat of [b, c, d]) expect(byVoter[seat.id]).toBe(ABSTAIN_TARGET_ID);

    const world2 = createWorld();
    const started2 = await startRound(world2, "6107");
    const r2 = round(world2, "6107");
    const [e, f, g, h] = started2.speakers;
    r2.phase = "tieBreak";
    r2.speechMode = undefined;
    r2.tieBreak = {
      candidateIds: [e.id, f.id],
      stage: "vote",
      descriptionsDone: [e.id, f.id],
      votes: [{ voterId: g.id, targetId: e.id }],
    };
    await startTimer(world2, started2.questioner);
    await expire(world2);
    const tieHistory = r2.voteHistory.at(-1)!;
    const tieVotes = Object.fromEntries(tieHistory.votes.map((v) => [v.voterId, v.targetId]));
    expect(tieVotes[g.id]).toBe(e.id);
    expect(tieVotes[h.id]).toBe(ABSTAIN_TARGET_ID);
    expect(tieVotes[e.id]).toBe(ABSTAIN_TARGET_ID);
    expect(tieVotes[f.id]).toBe(ABSTAIN_TARGET_ID);
  });

  test("夜晚超时：存活的平民与卧底记「未指定目标」，天使、白板与出局者不记", async () => {
    const world = createWorld();
    const started = await startRound(world, "6108");
    const r = round(world, "6108");
    const [a, b, c, d] = started.speakers;
    r.phase = "night";
    r.speechMode = undefined;
    r.nightActions = [];
    r.assignments[a.id].role = "civilian";
    r.assignments[b.id].role = "undercover";
    r.assignments[c.id].role = "blank";
    r.assignments[d.id].role = "civilian";
    r.assignments[d.id].alive = false;
    await startTimer(world, started.questioner);
    await expire(world);
    const entry = r.history.find((h) => h.kind === "night");
    expect(entry?.kind).toBe("night");
    if (entry?.kind !== "night") return;
    expect(entry.actions.map((x) => x.actorId).sort()).toEqual([a.id, b.id].sort());
    expect(entry.actions.every((x) => x.targetId === undefined)).toBe(true);
    expect(entry.actions.find((x) => x.actorId === a.id)?.actorRole).toBe("civilian");
    expect(entry.actions.find((x) => x.actorId === b.id)?.actorRole).toBe("undercover");
  });

  test("机器人：投票只在非候选且没投时出手；夜晚只有卧底出手、天使不动", async () => {
    const world = createWorld();
    const host = await makeRoom(world, "Oblivionis");
    await send(world, host.conn, { id: "b", type: "test.addBot", payload: { count: 4 } });
    await send(world, host.conn, {
      id: "j",
      type: "test.jumpToPhase",
      payload: { phase: "voting" },
    });
    const room = world.room("Oblivionis");
    const r = room.round!;
    const bots = Object.values(room.players).filter((p) => p.isBot);
    expect(r.votes.map((v) => v.voterId).sort()).toEqual(bots.map((b) => b.id).sort());
    expect(new Set(r.votes.map((v) => v.voterId)).size).toBe(r.votes.length);

    await send(world, host.conn, {
      id: "jt",
      type: "test.jumpToPhase",
      payload: { phase: "tieBreak" },
    });
    const tie = round(world, "Oblivionis");
    tie.tieBreak!.stage = "vote";
    tie.tieBreak!.votes = [];
    await send(world, host.conn, { id: "rb", type: "test.addBot", payload: { count: 1 } });
    const candidates = tie.tieBreak!.candidateIds;
    for (const vote of tie.tieBreak!.votes) expect(candidates.includes(vote.voterId)).toBe(false);

    await send(world, host.conn, {
      id: "jn",
      type: "test.jumpToPhase",
      payload: { phase: "night" },
    });
    const night = round(world, "Oblivionis");
    const actors = night.nightActions.map((n) => n.actorId);
    for (const id of actors) {
      const role = night.assignments[id].role;
      expect(role === "civilian" || role === "undercover").toBe(true);
    }
    expect(new Set(actors).size).toBe(actors.length);
  });

  test("投票超时：出局者与出题人（即使在分配表里）都不记弃权；平票投票超时同样不给出题人记", async () => {
    const world = createWorld();
    const started = await startRound(world, "6120");
    const r = round(world, "6120");
    const [a, b, c, d] = started.speakers;
    r.assignments[started.questioner.id] = { ...r.assignments[a.id] };
    r.assignments[a.id].alive = false;
    r.phase = "voting";
    r.speechMode = undefined;
    r.votes = [];
    await startTimer(world, started.questioner);
    await expire(world);
    const voters = r.voteHistory
      .at(-1)!
      .votes.map((v) => v.voterId)
      .sort();
    expect(voters).toEqual([b.id, c.id, d.id].sort());

    const world2 = createWorld();
    const started2 = await startRound(world2, "6121");
    const r2 = round(world2, "6121");
    const [e, f, g, h] = started2.speakers;
    r2.assignments[started2.questioner.id] = { ...r2.assignments[e.id] };
    r2.phase = "tieBreak";
    r2.speechMode = undefined;
    r2.tieBreak = {
      candidateIds: [e.id, f.id],
      stage: "vote",
      descriptionsDone: [e.id, f.id],
      votes: [],
    };
    await startTimer(world2, started2.questioner);
    await expire(world2);
    const tieVoters = r2.voteHistory.at(-1)!.votes.map((v) => v.voterId);
    expect(tieVoters).not.toContain(started2.questioner.id);
    expect(tieVoters).toContain(g.id);
    expect(tieVoters).toContain(h.id);
  });

  test("夜晚超时：已经行动的人不被覆盖", async () => {
    const world = createWorld();
    const started = await startRound(world, "6122");
    const r = round(world, "6122");
    const [a, b, c, d] = started.speakers;
    r.phase = "night";
    r.speechMode = undefined;
    r.assignments[a.id].role = "civilian";
    r.assignments[b.id].role = "undercover";
    r.assignments[c.id].role = "civilian";
    r.assignments[d.id].role = "blank";
    r.nightActions = [{ actorId: b.id, actorRole: "undercover", targetId: c.id }];
    await startTimer(world, started.questioner);
    await expire(world);
    const entry = r.history.find((h) => h.kind === "night");
    if (entry?.kind !== "night") throw new Error("缺少夜晚记录");
    expect(entry.actions.filter((x) => x.actorId === b.id)).toEqual([
      { actorId: b.id, actorRole: "undercover", targetId: c.id },
    ]);
    expect(entry.actions.map((x) => x.actorId).sort()).toEqual([a.id, b.id, c.id].sort());
  });

  test("发言者不在顺位表里时不标顺位：机器人补发言取不到位次", async () => {
    const world = createWorld();
    const host = await makeRoom(world, "Oblivionis");
    await send(world, host.conn, { id: "b", type: "test.addBot", payload: { count: 4 } });
    await send(world, host.conn, {
      id: "j",
      type: "test.jumpToPhase",
      payload: { phase: "description" },
    });
    const room = world.room("Oblivionis");
    const r = round(world, "Oblivionis");
    const bot = Object.values(room.players).find((p) => p.isBot)!;
    r.descriptionOrder = r.descriptionOrder.filter((id) => id !== bot.id);
    r.descriptionSubmittedBy = r.descriptionSubmittedBy.filter((id) => id !== bot.id);
    r.descriptions = r.descriptions.filter((d) => d.playerId !== bot.id);
    await send(world, host.conn, { id: "b2", type: "test.addBot", payload: { count: 1 } });
    const again = r.descriptions.filter((d) => d.playerId === bot.id);
    expect(again).toHaveLength(1);
    expect(again[0].order).toBeUndefined();
  });

  test("机器人：已投的不再改票、非夜晚不行动、夜晚只有平民与卧底、已行动的不覆盖、平票记录取当前加赛次数", async () => {
    const world = createWorld();
    const host = await makeRoom(world, "Oblivionis");
    await send(world, host.conn, { id: "b", type: "test.addBot", payload: { count: 4 } });
    const nudge = () =>
      send(world, host.conn, {
        id: `n${world.now()}${Math.random()}`,
        type: "test.addBot",
        payload: { count: 1 },
      });
    await send(world, host.conn, {
      id: "j",
      type: "test.jumpToPhase",
      payload: { phase: "description" },
    });
    const room = world.room("Oblivionis");
    const r = round(world, "Oblivionis");
    // 非夜晚阶段机器人不产生夜晚行动
    expect(r.nightActions).toEqual([]);
    await send(world, host.conn, {
      id: "jv",
      type: "test.jumpToPhase",
      payload: { phase: "voting" },
    });
    await nudge();
    expect(r.nightActions).toEqual([]);
    // 已投票的机器人不再改票
    const bots = Object.values(room.players).filter((p) => p.isBot);
    const preset = r.votes[0];
    const other = Object.keys(r.assignments).find(
      (id) => id !== preset.voterId && id !== preset.targetId
    )!;
    r.votes[0] = { ...preset, targetId: other };
    await nudge();
    expect(r.votes.find((v) => v.voterId === preset.voterId)?.targetId).toBe(other);
    // 夜晚：白板不动，平民与卧底各一次；已行动的卧底不被覆盖
    await send(world, host.conn, {
      id: "jn",
      type: "test.jumpToPhase",
      payload: { phase: "night" },
    });
    const night = round(world, "Oblivionis");
    const [x, y, z] = bots;
    night.nightActions = [];
    night.assignments[x.id].role = "blank";
    night.assignments[y.id].role = "civilian";
    night.assignments[z.id].role = "undercover";
    const alive = Object.keys(night.assignments).filter(
      (id) => night.assignments[id].alive && id !== z.id
    );
    night.nightActions = [{ actorId: z.id, actorRole: "undercover", targetId: alive[0] }];
    await nudge();
    const actors = night.nightActions.map((n) => n.actorId);
    expect(actors).not.toContain(x.id);
    expect(actors).toContain(y.id);
    expect(night.nightActions.find((n) => n.actorId === z.id)?.targetId).toBe(alive[0]);
    // 平票：记录取当前加赛次数
    await send(world, host.conn, {
      id: "jt",
      type: "test.jumpToPhase",
      payload: { phase: "tieBreak" },
    });
    const tie = round(world, "Oblivionis");
    tie.tieBreakCount = 3;
    tie.tieBreak!.descriptionsDone = [];
    tie.descriptions = [];
    await nudge();
    const entries = tie.descriptions.filter((d) => d.kind === "tieBreak");
    expect(entries.length).toBeGreaterThan(0);
    for (const entry of entries) expect(entry.tieBreakIndex).toBe(3);
  });
});
