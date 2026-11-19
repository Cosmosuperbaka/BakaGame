import { expect, test } from "bun:test";

import { resolveNight, resolveVoting } from "../../src/application/whoisfaker/Resolution";
import type { GameRound } from "../../src/shared/Index";
import { execute } from "../Helpers";
import { resetBase, setupRoom } from "./ForcedRemovalHarness";

/**
 * 投票与夜晚结算中间有 `await ctx.log(...)`，而房间命令、阶段定时器回调、巡检之间没有按房互斥。
 * 结算不被交错靠的是：日志写入同步，等它只让出微任务，事先排好的宏任务要等结算整个跑完才会执行。
 * 这里在结算开始前排好一条到点回调和一条玩家命令，断言它们在结算返回之前都没有执行。
 */

const scheduleCompetitors = (h: Awaited<ReturnType<typeof setupRoom>>, events: string[]): void => {
  setTimeout(() => {
    events.push("到点回调");
  }, 0);
  setTimeout(() => {
    events.push("玩家命令");
    void execute(h.service, h.host, { id: "late", type: "game.cancelVote", payload: {} }).catch(
      () => undefined
    );
  }, 0);
};

const afterMacrotasks = () => new Promise((resolve) => setTimeout(resolve, 5));

test("投票结算进行中（日志等待处），事先排好的到点回调与玩家命令插不进来", async () => {
  const h = await setupRoom();
  const round = resetBase(h);
  round.phase = "voting";
  round.speechMode = undefined;
  round.votes = [
    { voterId: h.idOf("房主"), targetId: h.idOf("机3") },
    { voterId: h.idOf("机1"), targetId: h.idOf("机3") },
  ];
  const events: string[] = [];
  scheduleCompetitors(h, events);

  await resolveVoting(h.service.ctx, h.room, false);

  expect(events).toEqual([]);
  const phase = round.phase as GameRound["phase"];
  expect(phase).toBe("feedback");
  expect(round.feedback?.eliminatedPlayerIds).toEqual([h.idOf("机3")]);

  await afterMacrotasks();
  expect(events).toEqual(["到点回调", "玩家命令"]);
});

test("夜晚结算进行中（日志等待处），事先排好的到点回调与玩家命令插不进来", async () => {
  const h = await setupRoom();
  const round = resetBase(h);
  round.phase = "night";
  round.speechMode = undefined;
  round.nightActions = [
    { actorId: h.idOf("机3"), actorRole: "undercover", targetId: h.idOf("机1") },
  ];
  const events: string[] = [];
  scheduleCompetitors(h, events);

  await resolveNight(h.service.ctx, h.room);

  expect(events).toEqual([]);
  const phase = round.phase as GameRound["phase"];
  expect(phase).toBe("feedback");
  expect(round.nightActions).toEqual([]);

  await afterMacrotasks();
  expect(events).toEqual(["到点回调", "玩家命令"]);
});
