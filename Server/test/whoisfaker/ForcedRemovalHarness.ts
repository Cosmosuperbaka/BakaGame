import type { TimerSeam } from "../../src/application/room/RoomTimers";
import type { GameRound } from "../../src/shared/Index";
import { createTestContext, execute } from "../Helpers";
import { createRoom, joinPlayers } from "./Fixtures";

/** 强制移除与猜词恢复的刻画用例共用的现场：七名参战玩家（四平民、两卧底、一白板），房主与一名真人有连接，其余是机器人。 */
export const ROOM_ID = "Oblivionis";
export const ROSTER = ["房主", "路人1", "机1", "机2", "机3", "机4", "机5"] as const;
export type Name = (typeof ROSTER)[number];

/** 手动驱动的定时器接缝：只记录挂载与取消。 */
export const manualTimers = () => {
  const entries: Array<{ delayMs: number; cancelled: boolean }> = [];
  const setTimer: TimerSeam = (_fire, delayMs) => {
    const entry = { delayMs, cancelled: false };
    entries.push(entry);
    return {
      cancel: () => {
        entry.cancelled = true;
      },
    };
  };
  return { setTimer, live: () => entries.filter((entry) => !entry.cancelled) };
};

/** 搭好的现场：七名参战玩家（四平民、两卧底、一白板），房主与一名真人有连接，其余是机器人。 */
export const setupRoom = async () => {
  const timers = manualTimers();
  const { service, advanceTime } = createTestContext({ setTimer: timers.setTimer });
  const { host, result: hostSeat } = await createRoom(service, ROOM_ID, "房主");
  const [human] = await joinPlayers(service, ROOM_ID, 1, "路人");
  await execute(service, host, { id: "bots", type: "test.addBot", payload: { count: 5 } });
  await execute(service, host, {
    id: "jump",
    type: "test.jumpToPhase",
    payload: { phase: "description" },
  });
  const room = service.rooms.get(ROOM_ID)!;
  const bots = Object.values(room.players)
    .filter((player) => player.isBot)
    .sort((left, right) => left.joinedAt - right.joinedAt || (left.id < right.id ? -1 : 1));
  bots.forEach((bot, index) => {
    bot.name = `机${index + 1}`;
  });
  room.players[hostSeat.playerId].name = "房主";
  room.players[human.joinResult.playerId].name = "路人1";
  const idOf = (name: Name): string => {
    const found = Object.values(room.players).find((player) => player.name === name);
    if (!found) throw new Error(`没有名为 ${name} 的玩家`);
    return found.id;
  };
  return { service, advanceTime, timers, host, human, room, idOf, hostSeat };
};

export type Harness = Awaited<ReturnType<typeof setupRoom>>;

/** 回合重置到「描述阶段第一天、七人全部存活」的干净底座，场景在此之上改。 */
export const resetBase = (h: Harness) => {
  const round = h.room.round!;
  const roles: Record<Name, "civilian" | "undercover" | "blank"> = {
    房主: "civilian",
    路人1: "civilian",
    机1: "civilian",
    机2: "civilian",
    机3: "undercover",
    机4: "undercover",
    机5: "blank",
  };
  round.assignments = {};
  for (const name of ROSTER) {
    const role = roles[name];
    round.assignments[h.idOf(name)] = {
      role,
      side: role === "civilian" ? "good" : role === "undercover" ? "undercover" : "blank",
      word: role === "civilian" ? "苹果" : role === "undercover" ? "香蕉" : undefined,
      alive: true,
    };
  }
  round.words = {
    pair: ["苹果", "香蕉"],
    civilianWord: "苹果",
    undercoverWord: "香蕉",
    blankHint: "测试提示",
  };
  round.questionerPlayerId = undefined;
  round.phase = "description";
  round.speechMode = "normal";
  round.day = 1;
  round.descriptionCycle = 1;
  round.descriptionOrder = ROSTER.map((name) => h.idOf(name));
  round.descriptionSubmittedBy = [];
  round.descriptions = [];
  round.votes = [];
  round.voteHistory = [];
  round.history = [];
  round.nightActions = [];
  round.tieBreak = undefined;
  round.supplement = undefined;
  round.blankGuessUsed = false;
  round.blankGuessRecords = [];
  round.blankGuessContext = undefined;
  round.feedback = undefined;
  round.feedbackContinuation = undefined;
  round.pendingDisconnectPlayerIds = [];
  round.questionerReconnectDeadlineAt = undefined;
  round.phaseTimer = undefined;
  round.summary = undefined;
  h.service.ctx.timers.clear(ROOM_ID);
  return round;
};

export const dead = (round: GameRound, id: (name: Name) => string, ...names: Name[]) => {
  for (const name of names) round.assignments[id(name)].alive = false;
};
