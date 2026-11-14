import { expect, test } from "bun:test";

import { PHASE_RESULT_DISPLAY_MS } from "../src/config/Constants";
import { ROOM_ID_TEST_MODE } from "../src/shared/ModelValues";
import { ABSTAIN_TARGET_ID } from "../src/shared/WhoIsFakerValues";
import type {
  SpeechMode,
  WhoIsFakerClientMessage,
  WhoIsFakerPhase,
  WhoIsFakerPrivateState,
  WhoIsFakerRole,
  WhoIsFakerRoomSnapshot,
} from "../src/shared/Index";
import {
  createConnection,
  createTestContext,
  execute,
  getLastEventPayload,
  type TestConnection,
} from "./Helpers";

// ==================== 对局夹具 ====================

type WithoutId<T> = T extends unknown ? Omit<T, "id"> : never;

interface Seat {
  label: string;
  client: TestConnection;
  id: string;
}

interface SeatView {
  label: string;
  snapshot: WhoIsFakerRoomSnapshot;
  privateState: WhoIsFakerPrivateState;
}

interface CheckpointRecord {
  label: string;
  phase: WhoIsFakerPhase;
  speechMode: SpeechMode;
  speechOrder: string[];
  submitted: string[];
  acting: string[];
  nightCapable: string[];
  roleCounts?: Record<WhoIsFakerRole, number>;
}

/**
 * 必填不等于线上一定带：类型只约束编译期，这里钉的是每个座位的载荷真的带了这几位。
 * 出词人数只在该阶段的出题人私有态里出现，别的阶段与座位多给一位也算错。
 */
const deliveryProblems = (at: string, view: SeatView): string[] => {
  const problems: string[] = [];
  const status: Partial<WhoIsFakerRoomSnapshot["status"]> = view.snapshot.status;
  const priv: Partial<WhoIsFakerPrivateState> = view.privateState;
  if (status.speechMode === undefined) problems.push(`${at}: speechMode 未下发`);
  if (status.speechOrder === undefined) problems.push(`${at}: speechOrder 未下发`);
  if (status.submittedSpeechPlayerIds === undefined) {
    problems.push(`${at}: submittedSpeechPlayerIds 未下发`);
  }
  if (typeof priv.canAct !== "boolean") problems.push(`${at}: canAct 未下发`);
  if (typeof priv.canActAtNight !== "boolean") problems.push(`${at}: canActAtNight 未下发`);
  const wantCounts = view.snapshot.status.phase === "wordSubmission" && priv.isQuestioner === true;
  if (wantCounts !== (priv.requiredRoleCounts !== undefined)) {
    problems.push(`${at}: requiredRoleCounts 下发时机不对`);
  }
  return problems;
};

const ROLE_BY_LABEL: Record<string, WhoIsFakerRole> = {
  房主: "civilian",
  玩家1: "undercover",
  玩家2: "civilian",
  玩家3: "angel",
  玩家4: "blank",
  玩家5: "civilian",
  玩家6: "undercover",
  玩家7: "civilian",
};

const ALL_PHASES: WhoIsFakerPhase[] = [
  "waiting",
  "assigningQuestioner",
  "wordSubmission",
  "description",
  "voting",
  "tieBreak",
  "night",
  "blankGuess",
  "feedback",
  "gameOver",
];

/**
 * 一局走完整条阶段链：房主本人参赛、旁观者出题、另一位旁观者不开上帝视角，
 * 平票 PK 淘汰一人后该座位全程作为「已淘汰者」视角继续对账。
 * 每个观察点都逐连接重新取一次同步，保证读到的快照与私有态来自同一次发布。
 */
const walkAllPhases = async (roomId: string): Promise<CheckpointRecord[]> => {
  const { service, advanceTime } = createTestContext();
  let commandId = 0;
  const send = (client: TestConnection, message: WithoutId<WhoIsFakerClientMessage>) =>
    execute(service, client, { ...message, id: `walk-${++commandId}` } as WhoIsFakerClientMessage);

  const seats: Seat[] = [];
  const enroll = async (label: string, spectator: boolean) => {
    const client = createConnection(service, `walk-${roomId}-${label}`);
    if (seats.length === 0) {
      await send(client, {
        type: "room.create",
        payload: {
          roomId,
          name: "可行动对照",
          userName: label,
          visibility: "public",
          allowSpectators: true,
        },
      });
    } else {
      await send(client, { type: "room.join", roomId, payload: { userName: label } });
    }
    if (spectator)
      await send(client, { type: "player.setSpectator", payload: { spectator: true } });
    seats.push({ label, client, id: client.record.playerId! });
    return client;
  };

  const host = await enroll("房主", false);
  for (let index = 1; index <= 7; index += 1) await enroll(`玩家${index}`, false);
  const questioner = await enroll("出题人", true);
  await enroll("旁观者", true);

  const seatOf = (label: string) => seats.find((seat) => seat.label === label)!;
  const idOf = (label: string) => seatOf(label).id;
  const labelOf = (id: string) => seats.find((seat) => seat.id === id)?.label ?? id;
  const say = (label: string, text: string) =>
    send(seatOf(label).client, { type: "game.submitDescription", payload: { text } });
  const vote = (label: string, target: string) =>
    send(seatOf(label).client, { type: "game.submitVote", payload: { targetId: target } });
  const act = (label: string, targetId: string | null) =>
    send(seatOf(label).client, { type: "game.submitNightAction", payload: { targetId } });
  const advance = () => send(questioner, { type: "game.advancePhase", payload: {} });

  const records: CheckpointRecord[] = [];
  const checkpoint = async (label: string) => {
    for (const seat of seats) await send(seat.client, { type: "room.requestSync", payload: {} });
    const views: SeatView[] = seats.map((seat) => ({
      label: seat.label,
      snapshot: getLastEventPayload<WhoIsFakerRoomSnapshot>(seat.client, "room.snapshot")!,
      privateState: getLastEventPayload<WhoIsFakerPrivateState>(seat.client, "game.privateState")!,
    }));

    expect(views.flatMap((view) => deliveryProblems(`${label}/${view.label}`, view))).toEqual([]);

    const status = views[0].snapshot.status;
    records.push({
      label,
      phase: status.phase,
      speechMode: status.speechMode,
      speechOrder: status.speechOrder.map(labelOf),
      submitted: status.submittedSpeechPlayerIds.map(labelOf),
      acting: views.filter((view) => view.privateState.canAct === true).map((view) => view.label),
      nightCapable: views
        .filter((view) => view.privateState.canActAtNight === true)
        .map((view) => view.label),
      roleCounts: views.find((view) => view.privateState.isQuestioner)?.privateState
        .requiredRoleCounts,
    });
  };

  await send(host, {
    type: "room.updateSettings",
    payload: { roleConfig: { undercoverCount: 2, hasAngel: true, hasBlank: true } },
  });
  for (let index = 1; index <= 7; index += 1) {
    await send(seatOf(`玩家${index}`).client, {
      type: "player.setReady",
      payload: { ready: true },
    });
  }

  await checkpoint("等待");
  await send(host, { type: "game.advancePhase", payload: {} });
  await checkpoint("指定出题人");
  await send(host, { type: "game.assignQuestioner", payload: { playerId: idOf("出题人") } });
  await checkpoint("出词");

  const manualRoles = Object.fromEntries(
    seats
      .filter((seat) => ROLE_BY_LABEL[seat.label])
      .map((seat) => [seat.id, ROLE_BY_LABEL[seat.label]])
  );
  await send(questioner, {
    type: "game.submitWords",
    payload: { words: ["苹果", "香蕉"], blankHint: "水果", manualRoles },
  });
  await checkpoint("首轮描述未开始");
  await say("玩家1", "一种水果");
  await checkpoint("首轮描述进行中");
  for (const label of ["房主", "玩家2", "玩家3", "玩家4", "玩家5", "玩家6", "玩家7"]) {
    await say(label, "一种水果");
  }
  await checkpoint("首轮描述完成");

  await send(questioner, {
    type: "game.requestSupplement",
    payload: { playerIds: [idOf("玩家2"), idOf("玩家5")] },
  });
  await checkpoint("补充发言进行中");
  await say("玩家2", "补充一句");
  await checkpoint("补充发言剩一人");
  await say("玩家5", "补充一句");
  await checkpoint("补充发言完成");

  await advance();
  await checkpoint("首轮投票未开始");
  for (const label of ["房主", "玩家1", "玩家3"]) await vote(label, idOf("玩家2"));
  await checkpoint("首轮投票进行中");
  for (const label of ["玩家2", "玩家4", "玩家7"]) await vote(label, idOf("玩家6"));
  await vote("玩家5", ABSTAIN_TARGET_ID);
  await vote("玩家6", ABSTAIN_TARGET_ID);
  await checkpoint("首轮投票完成");
  await advance();
  await checkpoint("平票反馈");
  await advance();
  await checkpoint("平票发言未开始");
  await say("玩家2", "再辩一句");
  await checkpoint("平票发言进行中");
  await say("玩家6", "再辩一句");
  await checkpoint("平票发言完成");
  await advance();
  await checkpoint("平票投票未开始");
  await vote("房主", idOf("玩家2"));
  await checkpoint("平票投票进行中");
  for (const label of ["玩家1", "玩家3", "玩家4"]) await vote(label, idOf("玩家2"));
  for (const label of ["玩家5", "玩家7"]) await vote(label, idOf("玩家6"));
  await checkpoint("平票投票完成");
  await advance();
  await checkpoint("平票淘汰反馈");
  await advance();
  await checkpoint("首夜未行动");
  await act("玩家1", idOf("玩家7"));
  await checkpoint("首夜部分行动");
  await send(seatOf("玩家1").client, { type: "game.cancelNightAction", payload: {} });
  await checkpoint("首夜撤销后");
  for (const label of ["房主", "玩家1", "玩家5", "玩家6", "玩家7"]) await act(label, null);
  await checkpoint("首夜行动完成");
  await advance();
  await checkpoint("首夜反馈");
  await advance();
  await checkpoint("次日描述未开始");
  await say("玩家1", "第二天");
  await say("玩家5", "第二天");
  await checkpoint("次日描述进行中");

  await send(seatOf("玩家4").client, { type: "game.enterBlankGuess", payload: {} });
  await checkpoint("白板猜词打断");
  await send(seatOf("玩家4").client, {
    type: "game.updateBlankGuessDraft",
    payload: { words: ["西瓜", "橘子"] },
  });
  await checkpoint("白板草稿");
  await send(seatOf("玩家4").client, {
    type: "game.submitBlankGuess",
    payload: { words: ["西瓜", "橘子"] },
  });
  await checkpoint("白板待裁定");
  await send(questioner, { type: "game.reviewBlankGuess", payload: { approve: false } });
  await checkpoint("白板猜词反馈");
  await advance();
  await checkpoint("猜词失败回到描述");
  for (const label of ["房主", "玩家3", "玩家4", "玩家6", "玩家7"]) await say(label, "第二天");
  await checkpoint("次日描述完成");

  await advance();
  await checkpoint("次日投票未开始");
  for (const label of ["房主", "玩家3", "玩家4", "玩家5"]) await vote(label, idOf("玩家1"));
  await checkpoint("次日投票进行中");
  for (const label of ["玩家1", "玩家6", "玩家7"]) await vote(label, idOf("房主"));
  await checkpoint("次日投票完成");
  await advance();
  await checkpoint("次日淘汰反馈");
  await advance();
  await checkpoint("次夜未行动");
  for (const label of ["房主", "玩家5", "玩家6", "玩家7"]) await act(label, null);
  await checkpoint("次夜行动完成");
  await advance();
  await checkpoint("次夜反馈");
  await advance();
  await checkpoint("第三日描述未开始");
  for (const label of ["房主", "玩家3", "玩家4", "玩家5", "玩家6", "玩家7"]) {
    await say(label, "第三天");
  }
  await checkpoint("第三日描述完成");
  await advance();
  await checkpoint("第三日投票未开始");
  for (const label of ["房主", "玩家3", "玩家4", "玩家5", "玩家7"])
    await vote(label, idOf("玩家6"));
  await vote("玩家6", idOf("玩家7"));
  await checkpoint("第三日投票完成");
  await advance();
  await checkpoint("卧底出局反馈");
  await advance();
  await checkpoint("结算");

  advanceTime(PHASE_RESULT_DISPLAY_MS);
  await send(host, { type: "game.advancePhase", payload: {} });
  await checkpoint("回到等待");

  return records;
};

// ==================== 逐阶段期望值 ====================
// 这些名单是改造前客户端在同一局里逐阶段自行推导的结果，对账一致后固化成期望值。
// 座位用名字而不是 id：id 每次跑都不同，名字与入房顺序一一对应。

/** 入房顺序即首轮发言顺序；后续轮次按存活者依次去掉出局的人。 */
const ALL_SEATS = ["房主", "玩家1", "玩家2", "玩家3", "玩家4", "玩家5", "玩家6", "玩家7"];
const DAY2_ORDER = ["房主", "玩家1", "玩家3", "玩家4", "玩家5", "玩家6", "玩家7"];
const DAY3_ORDER = ["房主", "玩家3", "玩家4", "玩家5", "玩家6", "玩家7"];
const SUPPLEMENT_ORDER = ["玩家2", "玩家5"];
const TIE_ORDER = ["玩家2", "玩家6"];
const EVERYONE = [...ALL_SEATS, "出题人", "旁观者"];

/** 有夜间行动资格的存活平民与卧底，随玩家2、玩家1、玩家6 依次出局而缩短。 */
const NIGHT_CAPABLE_1 = ["房主", "玩家1", "玩家2", "玩家5", "玩家6", "玩家7"];
const NIGHT_CAPABLE_2 = ["房主", "玩家1", "玩家5", "玩家6", "玩家7"];
const NIGHT_CAPABLE_3 = ["房主", "玩家5", "玩家6", "玩家7"];
const NIGHT_CAPABLE_4 = ["房主", "玩家5", "玩家7"];

const FIRST_ROUND_DONE = ["玩家1", "房主", "玩家2", "玩家3", "玩家4", "玩家5", "玩家6", "玩家7"];
const SECOND_ROUND_DONE = ["玩家1", "玩家5", "房主", "玩家3", "玩家4", "玩家6", "玩家7"];

type RowRest = Partial<Omit<CheckpointRecord, "label" | "phase" | "acting">>;

/** 非发言阶段的缺省形态：模式 normal，两份名单为空。 */
const row = (
  label: string,
  phase: WhoIsFakerPhase,
  acting: string[],
  rest: RowRest = {}
): CheckpointRecord => ({
  label,
  phase,
  speechMode: "normal",
  speechOrder: [],
  submitted: [],
  nightCapable: [],
  roleCounts: undefined,
  ...rest,
  acting,
});

const EXPECTED: CheckpointRecord[] = [
  row("等待", "waiting", []),
  row("指定出题人", "assigningQuestioner", ["房主"]),
  row("出词", "wordSubmission", ["出题人"], {
    roleCounts: { civilian: 4, undercover: 2, angel: 1, blank: 1 },
  }),
  row("首轮描述未开始", "description", ALL_SEATS, {
    speechOrder: ALL_SEATS,
    nightCapable: NIGHT_CAPABLE_1,
  }),
  row(
    "首轮描述进行中",
    "description",
    ["房主", "玩家2", "玩家3", "玩家4", "玩家5", "玩家6", "玩家7"],
    {
      speechOrder: ALL_SEATS,
      submitted: ["玩家1"],
      nightCapable: NIGHT_CAPABLE_1,
    }
  ),
  row("首轮描述完成", "description", [], {
    speechOrder: ALL_SEATS,
    submitted: FIRST_ROUND_DONE,
    nightCapable: NIGHT_CAPABLE_1,
  }),
  row("补充发言进行中", "description", SUPPLEMENT_ORDER, {
    speechMode: "supplement",
    speechOrder: SUPPLEMENT_ORDER,
    nightCapable: NIGHT_CAPABLE_1,
  }),
  row("补充发言剩一人", "description", ["玩家5"], {
    speechMode: "supplement",
    speechOrder: SUPPLEMENT_ORDER,
    submitted: ["玩家2"],
    nightCapable: NIGHT_CAPABLE_1,
  }),
  row("补充发言完成", "description", [], {
    speechOrder: ALL_SEATS,
    submitted: FIRST_ROUND_DONE,
    nightCapable: NIGHT_CAPABLE_1,
  }),
  row("首轮投票未开始", "voting", ALL_SEATS, { nightCapable: NIGHT_CAPABLE_1 }),
  row("首轮投票进行中", "voting", ["玩家2", "玩家4", "玩家5", "玩家6", "玩家7"], {
    nightCapable: NIGHT_CAPABLE_1,
  }),
  row("首轮投票完成", "voting", [], { nightCapable: NIGHT_CAPABLE_1 }),
  row("平票反馈", "feedback", ["出题人"], { nightCapable: NIGHT_CAPABLE_1 }),
  row("平票发言未开始", "tieBreak", TIE_ORDER, {
    speechMode: "tieBreak",
    speechOrder: TIE_ORDER,
    nightCapable: NIGHT_CAPABLE_1,
  }),
  row("平票发言进行中", "tieBreak", ["玩家6"], {
    speechMode: "tieBreak",
    speechOrder: TIE_ORDER,
    submitted: ["玩家2"],
    nightCapable: NIGHT_CAPABLE_1,
  }),
  row("平票发言完成", "tieBreak", [], {
    speechMode: "tieBreak",
    speechOrder: TIE_ORDER,
    submitted: TIE_ORDER,
    nightCapable: NIGHT_CAPABLE_1,
  }),
  row("平票投票未开始", "tieBreak", ["房主", "玩家1", "玩家3", "玩家4", "玩家5", "玩家7"], {
    speechMode: "tieBreak",
    nightCapable: NIGHT_CAPABLE_1,
  }),
  row("平票投票进行中", "tieBreak", ["玩家1", "玩家3", "玩家4", "玩家5", "玩家7"], {
    speechMode: "tieBreak",
    nightCapable: NIGHT_CAPABLE_1,
  }),
  row("平票投票完成", "tieBreak", [], {
    speechMode: "tieBreak",
    nightCapable: NIGHT_CAPABLE_1,
  }),
  row("平票淘汰反馈", "feedback", ["出题人"], { nightCapable: NIGHT_CAPABLE_2 }),
  row("首夜未行动", "night", NIGHT_CAPABLE_2, { nightCapable: NIGHT_CAPABLE_2 }),
  row("首夜部分行动", "night", ["房主", "玩家5", "玩家6", "玩家7"], {
    nightCapable: NIGHT_CAPABLE_2,
  }),
  row("首夜撤销后", "night", NIGHT_CAPABLE_2, { nightCapable: NIGHT_CAPABLE_2 }),
  row("首夜行动完成", "night", [], { nightCapable: NIGHT_CAPABLE_2 }),
  row("首夜反馈", "feedback", ["出题人"], { nightCapable: NIGHT_CAPABLE_2 }),
  row("次日描述未开始", "description", DAY2_ORDER, {
    speechOrder: DAY2_ORDER,
    nightCapable: NIGHT_CAPABLE_2,
  }),
  row("次日描述进行中", "description", ["房主", "玩家3", "玩家4", "玩家6", "玩家7"], {
    speechOrder: DAY2_ORDER,
    submitted: ["玩家1", "玩家5"],
    nightCapable: NIGHT_CAPABLE_2,
  }),
  row("白板猜词打断", "blankGuess", ["玩家4"], {
    speechOrder: DAY2_ORDER,
    submitted: ["玩家1", "玩家5"],
    nightCapable: NIGHT_CAPABLE_2,
  }),
  row("白板草稿", "blankGuess", ["玩家4"], {
    speechOrder: DAY2_ORDER,
    submitted: ["玩家1", "玩家5"],
    nightCapable: NIGHT_CAPABLE_2,
  }),
  row("白板待裁定", "blankGuess", [], {
    speechOrder: DAY2_ORDER,
    submitted: ["玩家1", "玩家5"],
    nightCapable: NIGHT_CAPABLE_2,
  }),
  row("白板猜词反馈", "feedback", ["出题人"], { nightCapable: NIGHT_CAPABLE_2 }),
  row("猜词失败回到描述", "description", ["房主", "玩家3", "玩家4", "玩家6", "玩家7"], {
    speechOrder: DAY2_ORDER,
    submitted: ["玩家1", "玩家5"],
    nightCapable: NIGHT_CAPABLE_2,
  }),
  row("次日描述完成", "description", [], {
    speechOrder: DAY2_ORDER,
    submitted: SECOND_ROUND_DONE,
    nightCapable: NIGHT_CAPABLE_2,
  }),
  row("次日投票未开始", "voting", DAY2_ORDER, { nightCapable: NIGHT_CAPABLE_2 }),
  row("次日投票进行中", "voting", ["玩家1", "玩家6", "玩家7"], { nightCapable: NIGHT_CAPABLE_2 }),
  row("次日投票完成", "voting", [], { nightCapable: NIGHT_CAPABLE_2 }),
  row("次日淘汰反馈", "feedback", ["出题人"], { nightCapable: NIGHT_CAPABLE_3 }),
  row("次夜未行动", "night", NIGHT_CAPABLE_3, { nightCapable: NIGHT_CAPABLE_3 }),
  row("次夜行动完成", "night", [], { nightCapable: NIGHT_CAPABLE_3 }),
  row("次夜反馈", "feedback", ["出题人"], { nightCapable: NIGHT_CAPABLE_3 }),
  row("第三日描述未开始", "description", DAY3_ORDER, {
    speechOrder: DAY3_ORDER,
    nightCapable: NIGHT_CAPABLE_3,
  }),
  row("第三日描述完成", "description", [], {
    speechOrder: DAY3_ORDER,
    submitted: DAY3_ORDER,
    nightCapable: NIGHT_CAPABLE_3,
  }),
  row("第三日投票未开始", "voting", DAY3_ORDER, { nightCapable: NIGHT_CAPABLE_3 }),
  row("第三日投票完成", "voting", [], { nightCapable: NIGHT_CAPABLE_3 }),
  row("卧底出局反馈", "feedback", ["出题人"], { nightCapable: NIGHT_CAPABLE_4 }),
  row("结算", "gameOver", [], { nightCapable: NIGHT_CAPABLE_4 }),
  row("回到等待", "waiting", []),
];

/** 测试房只放开反馈阶段：全房都能推进，其余阶段与普通房一字不差。 */
const TEST_MODE_EXPECTED: CheckpointRecord[] = EXPECTED.map((record) =>
  record.phase === "feedback" ? { ...record, acting: EVERYONE } : record
);

const expectFullCoverage = (records: CheckpointRecord[]) => {
  expect(new Set(records.map((record) => record.phase))).toEqual(new Set(ALL_PHASES));
};

test("普通房：可行动与发言名单逐阶段等于期望值", async () => {
  const records = await walkAllPhases("8950");
  expectFullCoverage(records);
  expect(records).toEqual(EXPECTED);
});

test("测试房：反馈阶段放开给全房，其余阶段与普通房一致", async () => {
  const records = await walkAllPhases(ROOM_ID_TEST_MODE);
  expectFullCoverage(records);
  expect(records).toEqual(TEST_MODE_EXPECTED);
});

// 上面那条链里出题人是旁观者，正式玩家全员参赛，扣不扣出题人自己都是同一个数。
// 正式玩家出题时要扣掉自身名额，单独走一遍才钉得住；九名正式玩家扣掉出题人剩八人，
// 正好够天使与白板的开席门槛，配置不会被夹掉。
test("正式玩家出题：出词人数扣掉他自己，其余座位不下发", async () => {
  const roomId = "8951";
  const { service } = createTestContext();
  let commandId = 0;
  const send = (client: TestConnection, message: WithoutId<WhoIsFakerClientMessage>) =>
    execute(service, client, { ...message, id: `self-${++commandId}` } as WhoIsFakerClientMessage);

  const host = createConnection(service, `self-${roomId}-房主`);
  await send(host, {
    type: "room.create",
    payload: {
      roomId,
      name: "出题人参赛",
      userName: "房主",
      visibility: "public",
      allowSpectators: true,
    },
  });
  const guests: TestConnection[] = [];
  for (let index = 1; index <= 8; index += 1) {
    const client = createConnection(service, `self-${roomId}-玩家${index}`);
    await send(client, { type: "room.join", roomId, payload: { userName: `玩家${index}` } });
    await send(client, { type: "player.setReady", payload: { ready: true } });
    guests.push(client);
  }
  // 一位开了上帝视角的旁观者：他与出题人走同一条私有态构造，但人数只该发给出题人。
  const watcher = createConnection(service, `self-${roomId}-旁观`);
  await send(watcher, { type: "room.join", roomId, payload: { userName: "旁观" } });
  await send(watcher, { type: "player.setSpectator", payload: { spectator: true } });
  await send(host, {
    type: "room.updateSettings",
    payload: {
      roleConfig: { undercoverCount: 2, hasAngel: true, hasBlank: true },
      spectatorsSeeAnswers: true,
    },
  });
  await send(host, { type: "game.advancePhase", payload: {} });
  await send(host, {
    type: "game.assignQuestioner",
    payload: { playerId: host.record.playerId! },
  });

  const privateOf = async (client: TestConnection) => {
    await send(client, { type: "room.requestSync", payload: {} });
    return getLastEventPayload<WhoIsFakerPrivateState>(client, "game.privateState")!;
  };

  const hostState = await privateOf(host);
  expect(hostState.isQuestioner).toBe(true);
  expect(hostState.canAct).toBe(true);
  expect(hostState.requiredRoleCounts).toEqual({
    civilian: 4,
    undercover: 2,
    angel: 1,
    blank: 1,
  });
  for (const guest of guests) {
    const state = await privateOf(guest);
    expect(state.canAct).toBe(false);
    expect(state.requiredRoleCounts).toBeUndefined();
  }
  const watcherState = await privateOf(watcher);
  expect(watcherState.canAct).toBe(false);
  expect(watcherState.requiredRoleCounts).toBeUndefined();
});
