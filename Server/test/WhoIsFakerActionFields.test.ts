import { expect, test } from "bun:test";

import { getCurrentSpeechState } from "../src/application/whoisfaker/RoundRules";
import { PHASE_RESULT_DISPLAY_MS } from "../src/config/Constants";
import { ROOM_ID_TEST_MODE } from "../src/shared/ModelValues";
import { ABSTAIN_TARGET_ID } from "../src/shared/WhoIsFakerValues";
import type {
  PublicPlayerView,
  SpeechMode,
  WhoIsFakerClientMessage,
  WhoIsFakerPhase,
  WhoIsFakerPrivateState,
  WhoIsFakerRole,
  WhoIsFakerRoomRecord,
  WhoIsFakerRoomSnapshot,
} from "../src/shared/Index";
import {
  createConnection,
  createTestContext,
  execute,
  getLastEventPayload,
  type TestConnection,
} from "./Helpers";

// ==================== 预言机 ====================
// 下面三段是客户端现行推导的原样副本（WhoIsFakerSpeech.ts、WhoIsFakerActionSignals.ts、
// FakerWordSubmissionPhase.tsx）。抄进来是为了让「服务端下发的值」与「客户端今天自己算的值」
// 在同一局里逐阶段对账，而不是让服务端自说自话。唯一的改动是页面托管态换成常量桩：
// 服务端没有这个概念，托管只影响客户端要不要提醒，不影响玩法规则。
// 对账完成后整段删除，换成逐阶段期望值。

type SpeechStatus = WhoIsFakerRoomSnapshot["status"];

const speechModeOf = (status: SpeechStatus): SpeechMode =>
  status.speechMode ?? (status.phase === "tieBreak" ? "tieBreak" : "normal");

const speechOrderOf = (status: SpeechStatus): readonly string[] => status.speechOrder ?? [];

const submittedOf = (status: SpeechStatus): Set<string> =>
  new Set(status.submittedSpeechPlayerIds ?? []);

type Snapshot = WhoIsFakerRoomSnapshot;

const getPageControl = (): { status: string } => ({ status: "free" });

function canSpeak(
  snapshot: Snapshot,
  privateState: WhoIsFakerPrivateState,
  me: PublicPlayerView | undefined,
  mode: SpeechMode
): boolean {
  if (!me || me.roundStatus !== "alive" || privateState.isQuestioner) return false;
  if (submittedOf(snapshot.status).has(privateState.playerId)) return false;
  if (mode === "normal") return true;
  return speechOrderOf(snapshot.status).includes(privateState.playerId);
}

function canVote(
  snapshot: Snapshot,
  privateState: WhoIsFakerPrivateState,
  me: PublicPlayerView | undefined
): boolean {
  if (!me || me.roundStatus !== "alive" || privateState.isQuestioner) return false;
  if (privateState.myCurrentVoteTargetId) return false;
  const isTieBreak = snapshot.status.phase === "tieBreak";
  const candidates = snapshot.status.tieBreakCandidateIds ?? [];
  return !isTieBreak || !candidates.includes(privateState.playerId);
}

function whoIsFakerNeedsAction(
  snapshot: Snapshot | null,
  privateState: WhoIsFakerPrivateState | null
): boolean {
  if (!snapshot || !privateState || getPageControl().status === "controlled") return false;
  const phase = snapshot.status.phase;
  const me = snapshot.players.find((player) => player.id === privateState.playerId);

  if (phase === "assigningQuestioner") return me?.isHost === true;
  if (phase === "wordSubmission") return privateState.isQuestioner;
  if (phase === "description") {
    return canSpeak(snapshot, privateState, me, speechModeOf(snapshot.status));
  }
  if (phase === "tieBreak") {
    if (snapshot.status.tieBreakStage === "vote") return canVote(snapshot, privateState, me);
    return canSpeak(snapshot, privateState, me, "tieBreak");
  }
  if (phase === "voting") return canVote(snapshot, privateState, me);
  if (phase === "night") {
    return Boolean(
      me &&
      me.roundStatus === "alive" &&
      !privateState.isQuestioner &&
      privateState.canActAtNight &&
      !privateState.nightActionSubmitted
    );
  }
  if (phase === "blankGuess") {
    return privateState.canSubmitBlankGuess && snapshot.status.blankGuessPendingReview !== true;
  }
  if (phase === "feedback") return privateState.isQuestioner || snapshot.testMode;
  return false;
}

const ROLE_KEYS: WhoIsFakerRole[] = ["civilian", "undercover", "angel", "blank"];

function requiredRoleCountsOf(snapshot: Snapshot): Record<WhoIsFakerRole, number> {
  const roleConfig = snapshot.settings.roleConfig;
  const hasBlank = roleConfig.hasBlank;
  const hasAngel = roleConfig.hasAngel;
  const participants = snapshot.players.filter(
    (p) => p.membership === "active" && p.id !== snapshot.status.questionerPlayerId
  );
  return {
    civilian:
      participants.length - roleConfig.undercoverCount - (hasAngel ? 1 : 0) - (hasBlank ? 1 : 0),
    undercover: roleConfig.undercoverCount,
    angel: hasAngel ? 1 : 0,
    blank: hasBlank ? 1 : 0,
  };
}

/** 改造前服务端对这三个字段的原表达式：只有发言阶段才有值，其余阶段整个不下发。 */
const legacySpeechFields = (room: WhoIsFakerRoomRecord) => {
  const speechState = room.round ? getCurrentSpeechState(room.round) : undefined;
  return {
    speechMode: room.round?.speechMode,
    speechOrder: speechState ? [...speechState.order] : undefined,
    submittedSpeechPlayerIds: speechState ? [...speechState.submittedPlayerIds] : undefined,
  };
};

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

const roleCountsProblem = (
  at: string,
  snapshot: Snapshot,
  privateState: WhoIsFakerPrivateState
): string | undefined => {
  const expected =
    snapshot.status.phase === "wordSubmission" && privateState.isQuestioner
      ? requiredRoleCountsOf(snapshot)
      : undefined;
  const actual = privateState.requiredRoleCounts;
  const matches =
    expected === undefined
      ? actual === undefined
      : actual !== undefined && ROLE_KEYS.every((role) => actual[role] === expected[role]);
  return matches
    ? undefined
    : `${at}: requiredRoleCounts 下发 ${JSON.stringify(actual)}，旧推导 ${JSON.stringify(expected)}`;
};

/** 一个座位的对账结果：空数组表示下发值与客户端旧推导完全一致。 */
const seatProblems = (
  at: string,
  snapshot: Snapshot,
  privateState: WhoIsFakerPrivateState,
  legacy: ReturnType<typeof legacySpeechFields>
): string[] => {
  const oldStatus = { ...snapshot.status, ...legacy };
  const expected = whoIsFakerNeedsAction({ ...snapshot, status: oldStatus }, privateState);
  const problems: string[] = [];
  if (privateState.canAct !== expected) {
    problems.push(`${at}: canAct 下发 ${String(privateState.canAct)}，旧推导 ${expected}`);
  }
  if (typeof privateState.canActAtNight !== "boolean") problems.push(`${at}: canActAtNight 未下发`);
  if (snapshot.status.speechMode === undefined) problems.push(`${at}: speechMode 未下发`);
  if (snapshot.status.speechOrder === undefined) problems.push(`${at}: speechOrder 未下发`);
  if (snapshot.status.submittedSpeechPlayerIds === undefined) {
    problems.push(`${at}: submittedSpeechPlayerIds 未下发`);
  }
  if (speechModeOf(snapshot.status) !== speechModeOf(oldStatus)) {
    problems.push(`${at}: 发言模式推导值与旧值不同`);
  }
  if (speechOrderOf(snapshot.status).join() !== speechOrderOf(oldStatus).join()) {
    problems.push(`${at}: 应发言名单推导值与旧值不同`);
  }
  const now = [...submittedOf(snapshot.status)].sort().join();
  const old = [...submittedOf(oldStatus)].sort().join();
  if (now !== old) problems.push(`${at}: 已提交名单推导值与旧值不同`);
  const counts = roleCountsProblem(at, snapshot, privateState);
  if (counts) problems.push(counts);
  return problems;
};

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
    const room = service.rooms.get(roomId);
    if (!room) throw new Error(`房间 ${roomId} 不在册`);
    const legacy = legacySpeechFields(room);
    const views: SeatView[] = seats.map((seat) => ({
      label: seat.label,
      snapshot: getLastEventPayload<WhoIsFakerRoomSnapshot>(seat.client, "room.snapshot")!,
      privateState: getLastEventPayload<WhoIsFakerPrivateState>(seat.client, "game.privateState")!,
    }));

    expect(
      views.flatMap((view) =>
        seatProblems(`${label}/${view.label}`, view.snapshot, view.privateState, legacy)
      )
    ).toEqual([]);

    const status = views[0].snapshot.status;
    records.push({
      label,
      phase: status.phase,
      speechMode: speechModeOf(status),
      speechOrder: speechOrderOf(status).map(labelOf),
      submitted: [...submittedOf(status)].map(labelOf),
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

const expectFullCoverage = (records: CheckpointRecord[]) => {
  expect(new Set(records.map((record) => record.phase))).toEqual(new Set(ALL_PHASES));
};

test("普通房：服务端下发的可行动与发言名单逐阶段等于客户端旧推导", async () => {
  const records = await walkAllPhases("8950");
  expectFullCoverage(records);
});

test("测试房：反馈阶段放开给全房，其余阶段仍与客户端旧推导一致", async () => {
  const records = await walkAllPhases(ROOM_ID_TEST_MODE);
  expectFullCoverage(records);
});
