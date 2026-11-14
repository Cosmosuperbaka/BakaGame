import { describe, expect, test } from "bun:test";
import { forceRemovePlayer } from "../../src/application/whoisfaker/ForcedRemoval";
import { armPhaseTimer } from "../../src/application/whoisfaker/PhaseTimers";
import { publishRoom } from "../../src/application/whoisfaker/RoomPublish";
import type {
  GameRound,
  WhoIsFakerPrivateState,
  WhoIsFakerRoomRecord,
  WhoIsFakerRoomSnapshot,
} from "../../src/shared/Index";
import { getLastEventPayload } from "../Helpers";
import { FORCED_REMOVAL_GOLDEN } from "./ForcedRemovalGolden";
import {
  ROOM_ID,
  dead,
  resetBase,
  setupRoom,
  type Harness,
  type Name,
} from "./ForcedRemovalHarness";

/**
 * 强制移除玩家的现状刻画。
 *
 * 强制移除发生在每个阶段（发言、补充发言、投票、平票加赛、夜晚、白板猜词、反馈、结算前后）时，
 * 移除之后的回合数据、公开快照、各座位私有态、阶段定时器各是什么，逐场景记录成期望值。
 * 这组用例先在旧实现上全绿，再改写强制移除的实现，改写后不改断言全绿。
 * 场景用直接改回合数据的方式搭（白盒），入口是真实的强制移除函数加一次房间发布。
 */

type Scenario = {
  /** 被强制移除的人 */
  target: Name;
  /** 从哪个座位的连接看公开快照，缺省房主 */
  observer?: "房主" | "路人1";
  /** 移除前挂一个 60 秒的阶段倒计时 */
  timer?: boolean;
  build: (round: GameRound, id: (name: Name) => string) => void;
};

const SCENARIOS: Record<string, Scenario> = {
  // ---- 发言 ----
  发言中_尚未发言者被移除_带倒计时: {
    target: "机2",
    timer: true,
    build: (round, id) => {
      round.descriptionSubmittedBy = [id("房主"), id("机1")];
      round.pendingDisconnectPlayerIds = [id("机2")];
    },
  },
  发言中_已发言者被移除: {
    target: "机1",
    build: (round, id) => {
      round.descriptionSubmittedBy = [id("房主"), id("机1")];
    },
  },
  发言中_已出局者被移除: {
    target: "机2",
    build: (round, id) => {
      dead(round, id, "机2");
    },
  },
  发言中_房主被移除: {
    target: "房主",
    observer: "路人1",
    build: (round, id) => {
      round.descriptionSubmittedBy = [id("机1")];
    },
  },
  发言中_残局决出胜负_白板还有猜词机会: {
    target: "机3",
    build: (round, id) => {
      dead(round, id, "机4");
    },
  },
  发言中_残局决出胜负_白板已用过机会: {
    target: "机3",
    build: (round, id) => {
      dead(round, id, "机4");
      round.blankGuessUsed = true;
    },
  },
  // ---- 补充发言 ----
  补充发言中_最后一个待补充者被移除_补充随即完成回投票: {
    target: "机2",
    timer: true,
    build: (round, id) => {
      round.speechMode = "supplement";
      round.supplement = {
        index: 1,
        requestedPlayerIds: [id("机1"), id("机2")],
        donePlayers: [id("机1")],
        resumePhase: "voting",
      };
    },
  },
  补充发言中_仍有其他待补充者_补充继续: {
    target: "机2",
    timer: true,
    build: (round, id) => {
      round.speechMode = "supplement";
      round.votes = [{ voterId: id("房主"), targetId: id("机3") }];
      round.supplement = {
        index: 1,
        requestedPlayerIds: [id("机1"), id("机2"), id("机3")],
        donePlayers: [id("机1")],
        resumePhase: "voting",
      };
    },
  },
  补充发言中_补充完成后回原发言阶段: {
    target: "机2",
    build: (round, id) => {
      round.speechMode = "supplement";
      round.supplement = {
        index: 1,
        requestedPlayerIds: [id("机2")],
        donePlayers: [],
        resumePhase: "description",
      };
    },
  },
  // ---- 投票 ----
  投票中_被投者被移除_带倒计时: {
    target: "机2",
    timer: true,
    build: (round, id) => {
      round.phase = "voting";
      round.speechMode = undefined;
      round.votes = [
        { voterId: id("房主"), targetId: id("机2") },
        { voterId: id("路人1"), targetId: id("机3") },
        { voterId: id("机2"), targetId: id("机4") },
        { voterId: id("机1"), targetId: id("机2") },
      ];
      round.pendingDisconnectPlayerIds = [id("机2"), id("机1")];
    },
  },
  投票中_真人被移除: {
    target: "路人1",
    build: (round, id) => {
      round.phase = "voting";
      round.speechMode = undefined;
      round.votes = [
        { voterId: id("房主"), targetId: id("路人1") },
        { voterId: id("机1"), targetId: id("机3") },
      ];
    },
  },
  投票中_房主被移除: {
    target: "房主",
    observer: "路人1",
    build: (round, id) => {
      round.phase = "voting";
      round.speechMode = undefined;
      round.votes = [
        { voterId: id("房主"), targetId: id("机3") },
        { voterId: id("机1"), targetId: id("机3") },
      ];
    },
  },
  投票中_卧底被移除后好人不足_残局白板猜词: {
    target: "机1",
    build: (round, id) => {
      dead(round, id, "机2", "房主");
      round.phase = "voting";
      round.speechMode = undefined;
      round.votes = [{ voterId: id("路人1"), targetId: id("机3") }];
    },
  },
  投票中_卧底被移除后好人不足_白板已用过机会: {
    target: "机1",
    build: (round, id) => {
      dead(round, id, "机2", "房主");
      round.blankGuessUsed = true;
      round.phase = "voting";
      round.speechMode = undefined;
      round.votes = [{ voterId: id("路人1"), targetId: id("机3") }];
    },
  },
  // ---- 平票加赛 ----
  平票发言中_三名候选一人被移除: {
    target: "机3",
    timer: true,
    build: (round, id) => {
      round.phase = "tieBreak";
      round.speechMode = "tieBreak";
      round.tieBreakCount = 1;
      round.tieBreak = {
        candidateIds: [id("机1"), id("机3"), id("机4")],
        stage: "description",
        descriptionsDone: [id("机1")],
        votes: [],
      };
    },
  },
  平票发言中_候选不足被移除_改入夜晚: {
    target: "机3",
    timer: true,
    build: (round, id) => {
      round.phase = "tieBreak";
      round.speechMode = "tieBreak";
      round.tieBreakCount = 1;
      round.tieBreak = {
        candidateIds: [id("机1"), id("机3")],
        stage: "description",
        descriptionsDone: [],
        votes: [],
      };
    },
  },
  平票投票中_非候选投票者被移除: {
    target: "机2",
    timer: true,
    build: (round, id) => {
      round.phase = "tieBreak";
      round.speechMode = undefined;
      round.tieBreakCount = 1;
      round.tieBreak = {
        candidateIds: [id("机1"), id("机3")],
        stage: "vote",
        descriptionsDone: [id("机1"), id("机3")],
        votes: [
          { voterId: id("房主"), targetId: id("机1") },
          { voterId: id("机2"), targetId: id("机3") },
        ],
      };
    },
  },
  平票投票中_候选被移除_改入夜晚: {
    target: "机3",
    timer: true,
    build: (round, id) => {
      round.phase = "tieBreak";
      round.speechMode = undefined;
      round.tieBreakCount = 1;
      round.tieBreak = {
        candidateIds: [id("机1"), id("机3")],
        stage: "vote",
        descriptionsDone: [id("机1"), id("机3")],
        votes: [
          { voterId: id("房主"), targetId: id("机1") },
          { voterId: id("机2"), targetId: id("机3") },
        ],
      };
    },
  },
  // ---- 夜晚 ----
  夜晚中_行动者被移除_带倒计时: {
    target: "机3",
    timer: true,
    build: (round, id) => {
      round.phase = "night";
      round.speechMode = undefined;
      round.nightActions = [
        { actorId: id("房主"), actorRole: "civilian", targetId: id("机3") },
        { actorId: id("机3"), actorRole: "undercover", targetId: id("机1") },
        { actorId: id("机4"), actorRole: "undercover", targetId: id("机2") },
      ];
    },
  },
  夜晚中_真人行动者被移除: {
    target: "路人1",
    build: (round, id) => {
      round.phase = "night";
      round.speechMode = undefined;
      round.nightActions = [
        { actorId: id("房主"), actorRole: "civilian", targetId: id("机4") },
        { actorId: id("路人1"), actorRole: "civilian", targetId: id("机3") },
      ];
    },
  },
  夜晚中_最后一名卧底被移除_残局白板猜词: {
    target: "机3",
    build: (round, id) => {
      dead(round, id, "机4");
      round.phase = "night";
      round.speechMode = undefined;
      round.nightActions = [{ actorId: id("房主"), actorRole: "civilian", targetId: id("机3") }];
    },
  },
  // ---- 白板猜词：猜词者被移除 ----
  白板猜词_猜词者被移除_原阶段是发言: {
    target: "机5",
    timer: true,
    build: (round, id) => {
      round.phase = "blankGuess";
      round.speechMode = undefined;
      round.descriptionSubmittedBy = [id("房主")];
      round.blankGuessContext = {
        playerId: id("机5"),
        reason: "active",
        resumePhase: "description",
        interruptedRemainingTimerMs: 30_000,
        draft: ["苹果", ""],
      };
    },
  },
  白板猜词_猜词者被移除_原阶段是投票: {
    target: "机5",
    timer: true,
    build: (round, id) => {
      round.phase = "blankGuess";
      round.speechMode = undefined;
      round.votes = [
        { voterId: id("房主"), targetId: id("机3") },
        { voterId: id("机5"), targetId: id("机3") },
      ];
      round.blankGuessContext = {
        playerId: id("机5"),
        reason: "active",
        resumePhase: "voting",
      };
    },
  },
  白板猜词_猜词者被移除_原阶段是平票加赛且候选充足: {
    target: "机5",
    timer: true,
    build: (round, id) => {
      round.phase = "blankGuess";
      round.speechMode = undefined;
      round.tieBreakCount = 1;
      round.tieBreak = {
        candidateIds: [id("机1"), id("机3"), id("机4")],
        stage: "description",
        descriptionsDone: [id("机1")],
        votes: [],
      };
      round.blankGuessContext = {
        playerId: id("机5"),
        reason: "active",
        resumePhase: "tieBreak",
      };
    },
  },
  白板猜词_猜词者被移除_原阶段是平票加赛但候选不足: {
    target: "机5",
    build: (round, id) => {
      round.phase = "blankGuess";
      round.speechMode = undefined;
      round.tieBreakCount = 1;
      round.tieBreak = {
        candidateIds: [id("机1")],
        stage: "vote",
        descriptionsDone: [],
        votes: [{ voterId: id("房主"), targetId: id("机1") }],
      };
      round.blankGuessContext = {
        playerId: id("机5"),
        reason: "active",
        resumePhase: "tieBreak",
      };
    },
  },
  白板猜词_猜词者被移除_原阶段是夜晚: {
    target: "机5",
    timer: true,
    build: (round, id) => {
      round.phase = "blankGuess";
      round.speechMode = undefined;
      round.nightActions = [
        { actorId: id("房主"), actorRole: "civilian", targetId: id("机3") },
        { actorId: id("机5"), actorRole: "civilian", targetId: id("机3") },
      ];
      round.blankGuessContext = {
        playerId: id("机5"),
        reason: "active",
        resumePhase: "night",
      };
    },
  },
  白板猜词_残局猜词者被移除_按残局结算: {
    target: "机5",
    timer: true,
    build: (round, id) => {
      dead(round, id, "机3", "机4");
      round.phase = "blankGuess";
      round.speechMode = undefined;
      round.blankGuessContext = {
        playerId: id("机5"),
        reason: "finale",
        resumePhase: "gameOver",
        deferredWinner: "good",
      };
    },
  },
  白板猜词_补充发言被打断时猜词者被移除: {
    target: "机5",
    build: (round, id) => {
      round.phase = "blankGuess";
      round.speechMode = undefined;
      round.supplement = {
        index: 1,
        requestedPlayerIds: [id("机1"), id("机2")],
        donePlayers: [id("机1")],
        resumePhase: "voting",
      };
      round.votes = [{ voterId: id("房主"), targetId: id("机3") }];
      round.blankGuessContext = {
        playerId: id("机5"),
        reason: "active",
        resumePhase: "description",
      };
    },
  },
  // ---- 白板猜词：别人被移除 ----
  白板猜词中_其他人被移除_原阶段是平票加赛: {
    target: "机2",
    timer: true,
    build: (round, id) => {
      round.phase = "blankGuess";
      round.speechMode = undefined;
      round.votes = [{ voterId: id("房主"), targetId: id("机3") }];
      round.nightActions = [{ actorId: id("机2"), actorRole: "civilian", targetId: id("机4") }];
      round.tieBreakCount = 1;
      round.tieBreak = {
        candidateIds: [id("机1"), id("机3"), id("机4")],
        stage: "description",
        descriptionsDone: [id("机1")],
        votes: [],
      };
      round.blankGuessContext = {
        playerId: id("机5"),
        reason: "active",
        resumePhase: "tieBreak",
        draft: ["苹果", "香蕉"],
      };
    },
  },
  白板猜词中_其他人被移除_原阶段是夜晚: {
    target: "机2",
    timer: true,
    build: (round, id) => {
      round.phase = "blankGuess";
      round.speechMode = undefined;
      round.nightActions = [
        { actorId: id("房主"), actorRole: "civilian", targetId: id("机3") },
        { actorId: id("机2"), actorRole: "civilian", targetId: id("机4") },
        { actorId: id("机1"), actorRole: "civilian", targetId: id("机4") },
      ];
      round.blankGuessContext = {
        playerId: id("机5"),
        reason: "active",
        resumePhase: "night",
      };
    },
  },
  白板猜词中_其他人被移除_等待主持人裁定: {
    target: "机1",
    build: (round, id) => {
      round.phase = "blankGuess";
      round.speechMode = undefined;
      round.blankGuessUsed = true;
      round.blankGuessContext = {
        playerId: id("机5"),
        reason: "active",
        resumePhase: "voting",
        pendingReview: { words: ["苹果", "梨"] },
      };
    },
  },
  白板猜词中_其他人被移除_残局猜词: {
    target: "机2",
    build: (round, id) => {
      dead(round, id, "机3", "机4");
      round.phase = "blankGuess";
      round.speechMode = undefined;
      round.blankGuessContext = {
        playerId: id("机5"),
        reason: "finale",
        resumePhase: "gameOver",
        deferredWinner: "good",
      };
    },
  },
  // ---- 旧实现里恢复现场会覆盖阶段的几种边界：按现状钉住，改写后也要一致 ----
  白板猜词中_其他人被移除_补充发言被打断: {
    target: "机2",
    build: (round, id) => {
      round.phase = "blankGuess";
      round.speechMode = undefined;
      round.supplement = {
        index: 1,
        requestedPlayerIds: [id("机1"), id("机2"), id("机3")],
        donePlayers: [id("机1")],
        resumePhase: "voting",
      };
      round.votes = [{ voterId: id("房主"), targetId: id("机3") }];
      round.blankGuessContext = {
        playerId: id("机5"),
        reason: "active",
        resumePhase: "description",
        draft: ["苹果", ""],
      };
    },
  },
  补充发言中_移除致残局_白板还有猜词机会: {
    target: "机3",
    build: (round, id) => {
      dead(round, id, "机4");
      round.speechMode = "supplement";
      round.supplement = {
        index: 1,
        requestedPlayerIds: [id("机1"), id("机2")],
        donePlayers: [id("机1")],
        resumePhase: "voting",
      };
    },
  },
  平票发言中_移除致残局_白板还有猜词机会: {
    target: "机3",
    build: (round, id) => {
      dead(round, id, "机4");
      round.phase = "tieBreak";
      round.speechMode = "tieBreak";
      round.tieBreakCount = 1;
      round.tieBreak = {
        candidateIds: [id("机1"), id("机2"), id("机3")],
        stage: "description",
        descriptionsDone: [id("机1")],
        votes: [],
      };
    },
  },
  平票投票中_移除致残局_白板还有猜词机会: {
    target: "机3",
    build: (round, id) => {
      dead(round, id, "机4");
      round.phase = "tieBreak";
      round.speechMode = undefined;
      round.tieBreakCount = 1;
      round.tieBreak = {
        candidateIds: [id("机1"), id("机2"), id("机3")],
        stage: "vote",
        descriptionsDone: [id("机1"), id("机2"), id("机3")],
        votes: [{ voterId: id("房主"), targetId: id("机1") }],
      };
    },
  },
  白板猜词_猜词者被移除_移除后胜负已分: {
    target: "机5",
    timer: true,
    build: (round, id) => {
      dead(round, id, "机1", "机2");
      round.phase = "blankGuess";
      round.speechMode = undefined;
      round.votes = [{ voterId: id("房主"), targetId: id("机3") }];
      round.blankGuessContext = { playerId: id("机5"), reason: "active", resumePhase: "voting" };
    },
  },
  白板猜词_猜词者被移除_补充发言仍在进行且残局已定: {
    target: "机5",
    build: (round, id) => {
      dead(round, id, "机3", "机4");
      round.phase = "blankGuess";
      round.speechMode = undefined;
      round.supplement = {
        index: 1,
        requestedPlayerIds: [id("机1"), id("机2")],
        donePlayers: [id("机1")],
        resumePhase: "voting",
      };
      round.blankGuessContext = {
        playerId: id("机5"),
        reason: "active",
        resumePhase: "description",
      };
    },
  },
  // ---- 反馈 ----
  反馈中_投票后入夜_在场者被移除: {
    target: "机2",
    build: (round, id) => {
      dead(round, id, "机4");
      round.phase = "feedback";
      round.speechMode = undefined;
      round.feedback = {
        kind: "vote",
        day: 1,
        votes: [{ voterId: id("房主"), targetId: id("机4") }],
        eliminatedPlayerIds: [id("机4")],
        next: "night",
      };
      round.feedbackContinuation = {
        type: "advance",
        to: "night",
        winnerReason: "阶段结算后已满足胜利条件",
      };
    },
  },
  反馈中_投票后入夜_最后一名卧底被移除: {
    target: "机3",
    build: (round, id) => {
      dead(round, id, "机4");
      round.phase = "feedback";
      round.speechMode = undefined;
      round.feedback = {
        kind: "vote",
        day: 1,
        votes: [{ voterId: id("房主"), targetId: id("机4") }],
        eliminatedPlayerIds: [id("机4")],
        next: "night",
      };
      round.feedbackContinuation = {
        type: "advance",
        to: "night",
        winnerReason: "阶段结算后已满足胜利条件",
      };
    },
  },
  反馈中_平票续接_候选被移除: {
    target: "机3",
    build: (round, id) => {
      round.phase = "feedback";
      round.speechMode = undefined;
      round.feedback = {
        kind: "vote",
        day: 1,
        votes: [],
        eliminatedPlayerIds: [],
        tieBreakCandidateIds: [id("机1"), id("机3")],
        next: "tieBreak",
      };
      round.feedbackContinuation = { type: "tieBreak", candidateIds: [id("机1"), id("机3")] };
    },
  },
  反馈中_白板猜错_在场者被移除: {
    target: "机2",
    build: (round, id) => {
      round.phase = "feedback";
      round.speechMode = undefined;
      round.blankGuessUsed = true;
      round.feedback = {
        kind: "blankGuess",
        day: 1,
        eliminatedPlayerIds: [],
        next: "voting",
      };
      round.feedbackContinuation = { type: "blankFailed", message: "白板猜词未通过，游戏继续" };
      round.blankGuessContext = { playerId: id("机5"), reason: "active", resumePhase: "voting" };
    },
  },
  反馈中_白板猜错_白板自己被移除: {
    target: "机5",
    build: (round, id) => {
      round.phase = "feedback";
      round.speechMode = undefined;
      round.blankGuessUsed = true;
      round.feedback = {
        kind: "blankGuess",
        day: 1,
        eliminatedPlayerIds: [],
        next: "voting",
      };
      round.feedbackContinuation = { type: "blankFailed", message: "白板猜词未通过，游戏继续" };
      round.blankGuessContext = { playerId: id("机5"), reason: "active", resumePhase: "voting" };
    },
  },
  反馈中_已出局者被移除: {
    target: "机4",
    build: (round, id) => {
      dead(round, id, "机4");
      round.phase = "feedback";
      round.speechMode = undefined;
      round.feedback = {
        kind: "vote",
        day: 1,
        votes: [],
        eliminatedPlayerIds: [id("机4")],
        next: "night",
      };
      round.feedbackContinuation = {
        type: "advance",
        to: "night",
        winnerReason: "阶段结算后已满足胜利条件",
      };
    },
  },
  // ---- 回合开始前与结算后 ----
  指定出题人阶段_参战者被移除: {
    target: "机2",
    build: (round) => {
      round.phase = "assigningQuestioner";
      round.speechMode = undefined;
      round.assignments = {};
      round.words = undefined;
      round.descriptionOrder = [];
    },
  },
  出词阶段_出题人在场_参战者被移除: {
    target: "机2",
    build: (round, id) => {
      round.phase = "wordSubmission";
      round.speechMode = undefined;
      round.questionerPlayerId = id("房主");
      round.assignments = {};
      round.words = undefined;
      round.descriptionOrder = [];
    },
  },
  结算后_移除玩家: {
    target: "机2",
    build: (round) => {
      round.phase = "gameOver";
      round.speechMode = undefined;
      round.summary = {
        winner: "good",
        reason: "测试",
        awardedScores: [],
        revealedRoles: [],
        descriptions: [],
        blankGuesses: [],
        voteHistory: [],
        history: [],
      };
    },
  },
  出题人不参战_参战者被移除: {
    target: "机2",
    build: (round, id) => {
      dead(round, id, "机4");
      round.questionerPlayerId = id("路人1");
      delete round.assignments[id("路人1")];
      round.descriptionOrder = round.descriptionOrder.filter((pid) => pid !== id("路人1"));
    },
  },
};

const PICK_PRIVATE = [
  "canActAtNight",
  "specialRole",
  "isQuestioner",
  "canSubmitBlankGuess",
  "blankGuessUsed",
  "nightActionSubmitted",
  "myCurrentVoteTargetId",
  "myCurrentNightTargetId",
] as const;

/** 一条下行帧的紧凑摘要：事件名，快照取公开状态，私有态取与阶段有关的几个字段，其余取载荷。 */
const summarizeFrames = (sent: unknown[]) =>
  sent.map((frame) => {
    const entry = frame as { event?: string; payload?: unknown };
    if (entry.event === "room.snapshot") {
      const snapshot = entry.payload as WhoIsFakerRoomSnapshot;
      const status = { ...snapshot.status };
      delete status.roundId;
      return { 事件: entry.event, status, 玩家: snapshot.players.map((p) => p.roundStatus) };
    }
    if (entry.event === "game.privateState") {
      const state = entry.payload as WhoIsFakerPrivateState;
      return {
        事件: entry.event,
        ...Object.fromEntries(PICK_PRIVATE.map((key) => [key, state[key]])),
      };
    }
    return { 事件: entry.event, 载荷: entry.payload };
  });

/** 观察到的全部现状：回合数据、公开快照、各真人座位的私有态、阶段定时器。玩家 id 一律换成名字。 */
const observe = (h: Harness, scenario: Scenario, frames: unknown) => {
  const room: WhoIsFakerRoomRecord = h.room;
  const round = room.round!;
  const names = new Map(Object.values(room.players).map((player) => [player.id, player.name]));
  const toNames = <T>(value: T): T => {
    let text = JSON.stringify(value) ?? "null";
    for (const [id, name] of names) text = text.split(id).join(name);
    text = text.split(round.id).join("本局");
    return JSON.parse(text) as T;
  };

  const observerName = scenario.observer ?? "房主";
  const observerConn = observerName === "房主" ? h.host : h.human.connection;
  const snapshot = getLastEventPayload<WhoIsFakerRoomSnapshot>(observerConn, "room.snapshot")!;
  const status = { ...snapshot.status };
  delete status.roundId;
  const privates: Record<string, unknown> = {};
  for (const [name, conn] of [
    ["房主", h.host],
    ["路人1", h.human.connection],
  ] as const) {
    if (name === scenario.target) continue;
    const state = getLastEventPayload<WhoIsFakerPrivateState>(conn, "game.privateState");
    if (!state) continue;
    privates[name] = Object.fromEntries(PICK_PRIVATE.map((key) => [key, state[key]]));
  }

  const target = room.players[h.idOf(scenario.target)];
  return toNames({
    回合: {
      phase: round.phase,
      speechMode: round.speechMode,
      day: round.day,
      votes: round.votes,
      nightActions: round.nightActions,
      descriptionOrder: round.descriptionOrder,
      descriptionSubmittedBy: round.descriptionSubmittedBy,
      tieBreak: round.tieBreak,
      tieBreakCount: round.tieBreakCount,
      supplement: round.supplement,
      blankGuessContext: round.blankGuessContext,
      blankGuessUsed: round.blankGuessUsed,
      feedback: round.feedback,
      feedbackContinuation: round.feedbackContinuation,
      pendingDisconnectPlayerIds: round.pendingDisconnectPlayerIds,
      存活: Object.entries(round.assignments)
        .filter(([, state]) => state.alive)
        .map(([id]) => id),
      出局原因: Object.fromEntries(
        Object.entries(round.assignments)
          .filter(([, state]) => !state.alive)
          .map(([id, state]) => [id, state.eliminatedReason])
      ),
      移除记录: round.history.filter((entry) => entry.kind === "removal"),
      历史条数: round.history.length,
      结算: round.summary && { winner: round.summary.winner, reason: round.summary.reason },
      phaseTimer: round.phaseTimer,
    },
    被移除者: { membership: target.membership, online: target.online, isReady: target.isReady },
    房主: room.hostPlayerId,
    公开快照: {
      status,
      players: snapshot.players.map((player) => ({
        name: player.name,
        membership: player.membership,
        roundStatus: player.roundStatus,
        isHost: player.isHost,
      })),
      结算: snapshot.summary && { winner: snapshot.summary.winner },
    },
    私有态: privates,
    定时器: {
      在挂: h.service.ctx.timers.isArmed(ROOM_ID, "phase"),
      未取消: h.timers.live().map((t) => t.delayMs),
    },
    最近系统消息: room.chat.slice(-3).map((message) => message.text),
    移除过程中的下行帧: frames,
  });
};

const runScenario = async (scenario: Scenario) => {
  const h = await setupRoom();
  const round = resetBase(h);
  scenario.build(round, h.idOf);
  if (scenario.timer) {
    const state = {
      durationSeconds: 60,
      endsAt: Date.UTC(2026, 3, 10, 0, 0, 0) + 60_000,
      phase: round.phase,
      speechMode: round.speechMode,
      tieBreakStage: round.tieBreak?.stage,
    };
    round.phaseTimer = state;
    armPhaseTimer(h.service.ctx, h.room, state, 60_000);
  }
  const before = {
    房主: h.host.sent.length,
    路人1: h.human.connection.sent.length,
  };
  await forceRemovePlayer(h.service.ctx, h.room, h.idOf(scenario.target), "kick");
  // 强制移除函数自己发出的帧（调用方随后补发的发布不在内）：顺序与内容都是行为的一部分。
  const frames = {
    房主: summarizeFrames(h.host.sent.slice(before.房主)),
    路人1: summarizeFrames(h.human.connection.sent.slice(before.路人1)),
  };
  publishRoom(h.service.ctx, h.room);
  return observe(h, scenario, frames);
};

describe("强制移除玩家的现状刻画", () => {
  for (const [key, scenario] of Object.entries(SCENARIOS)) {
    test(key, async () => {
      const actual: unknown = await runScenario(scenario);
      expect(actual).toEqual(JSON.parse(FORCED_REMOVAL_GOLDEN[key]));
    });
  }

  test("每个场景都有期望值，期望值没有多余场景", () => {
    expect(Object.keys(FORCED_REMOVAL_GOLDEN).sort()).toEqual(Object.keys(SCENARIOS).sort());
  });
});

/** 几条最要紧的结论单独写成可读断言，期望值表之外再钉一道。 */
describe("强制移除玩家的关键结论", () => {
  const run = async (key: string) =>
    (await runScenario(SCENARIOS[key])) as {
      回合: {
        phase: string;
        speechMode?: string;
        votes: unknown[];
        nightActions: Array<{ actorId: string; targetId?: string }>;
        supplement?: { requestedPlayerIds: string[] };
        tieBreak?: { candidateIds: string[]; stage: string };
        blankGuessContext?: { reason: string; resumePhase?: string; draft?: string[] };
        移除记录: unknown[];
      };
      定时器: { 在挂: boolean; 未取消: number[] };
    };

  test("平票候选只剩一人被改入夜晚时，原平票阶段的倒计时同时撤销", async () => {
    for (const key of ["平票发言中_候选不足被移除_改入夜晚", "平票投票中_候选被移除_改入夜晚"]) {
      const result = await run(key);
      expect(result.回合.phase).toBe("night");
      expect(result.回合.tieBreak).toBeUndefined();
      expect(result.定时器).toEqual({ 在挂: false, 未取消: [] });
    }
  });

  test("补充发言被移除者收尾后随即完成时，回到原阶段并撤销补充的倒计时", async () => {
    const result = await run("补充发言中_最后一个待补充者被移除_补充随即完成回投票");
    expect(result.回合.phase).toBe("voting");
    expect(result.回合.supplement).toBeUndefined();
    expect(result.定时器.在挂).toBe(false);
  });

  test("补充发言仍有人未补时，移除别人不打断补充，倒计时与已投的票原样保留", async () => {
    const result = await run("补充发言中_仍有其他待补充者_补充继续");
    expect(result.回合.phase).toBe("description");
    expect(result.回合.speechMode).toBe("supplement");
    expect(result.回合.votes).toHaveLength(1);
    expect(result.定时器).toEqual({ 在挂: true, 未取消: [60_000] });
  });

  test("猜词的白板被移除：猜词作废，回到原阶段，原阶段已有的投票保留", async () => {
    const result = await run("白板猜词_猜词者被移除_原阶段是投票");
    expect(result.回合.phase).toBe("voting");
    expect(result.回合.blankGuessContext).toBeUndefined();
    expect(result.回合.votes).toHaveLength(1);
  });

  test("夜晚有人被移除：与他有关的行动删掉，其余人的行动保留，倒计时不动", async () => {
    const result = await run("夜晚中_行动者被移除_带倒计时");
    expect(result.回合.phase).toBe("night");
    expect(result.回合.nightActions).toHaveLength(1);
    expect(result.定时器).toEqual({ 在挂: true, 未取消: [60_000] });
  });

  // 白板猜词优先：猜词机会未决期间，任何人被强制移除都不改变阶段，仍停在白板猜词，
  // 发言模式不写成被打断阶段的模式；被打断的补充发言与平票加赛原样保留，等猜词收束后走恢复路径。
  test("猜词打断补充发言时移除别人：仍停在猜词，补充发言与猜词上下文原样保留", async () => {
    const result = await run("白板猜词中_其他人被移除_补充发言被打断");
    expect(result.回合.phase).toBe("blankGuess");
    expect(result.回合.speechMode).toBeUndefined();
    expect(result.回合.supplement?.requestedPlayerIds).toHaveLength(2);
    expect(result.回合.blankGuessContext).toMatchObject({
      reason: "active",
      resumePhase: "description",
      draft: ["苹果", ""],
    });
  });

  test("补充发言中移除致残局：进入残局猜词，阶段与发言模式一致，补充发言状态不动", async () => {
    const result = await run("补充发言中_移除致残局_白板还有猜词机会");
    expect(result.回合.phase).toBe("blankGuess");
    expect(result.回合.speechMode).toBeUndefined();
    expect(result.回合.blankGuessContext?.reason).toBe("finale");
    expect(result.回合.supplement?.requestedPlayerIds).toHaveLength(2);
  });

  test("平票加赛中移除致残局：进入残局猜词，发言模式不写成平票发言，平票状态不动", async () => {
    for (const [key, stage] of [
      ["平票发言中_移除致残局_白板还有猜词机会", "description"],
      ["平票投票中_移除致残局_白板还有猜词机会", "vote"],
    ] as const) {
      const result = await run(key);
      expect(result.回合.phase).toBe("blankGuess");
      expect(result.回合.speechMode).toBeUndefined();
      expect(result.回合.blankGuessContext?.reason).toBe("finale");
      expect(result.回合.tieBreak?.stage).toBe(stage);
      expect(result.回合.tieBreak?.candidateIds).toHaveLength(2);
    }
  });

  test("已出局的人被移除不再追加移除记录", async () => {
    for (const key of ["发言中_已出局者被移除", "反馈中_已出局者被移除", "结算后_移除玩家"]) {
      expect((await run(key)).回合.移除记录).toHaveLength(0);
    }
  });
});

describe("移除原因对外的文案与历史码", () => {
  // 出局原因的文案进玩家看得到的回合数据，历史码进回放记录：两样都是对外契约，逐个原因钉住。
  const CAUSES = [
    ["hostKick", "房主已将其移出房间", "kicked"],
    ["adminKick", "管理员已将其移出房间", "kicked"],
    ["disconnect", "掉线后被出题人移出", "disconnected"],
    ["leave", "leave", "left"],
    ["timeout", "timeout", "timeout"],
    ["kick", "kicked", "kicked"],
  ] as const;

  for (const [cause, text, history] of CAUSES) {
    test(`${cause}：出局原因「${text}」，历史码 ${history}`, async () => {
      const h = await setupRoom();
      const round = resetBase(h);
      const target = h.idOf("机1");
      await forceRemovePlayer(h.service.ctx, h.room, target, cause);
      expect(round.assignments[target]?.eliminatedReason).toBe(text);
      expect(round.history.filter((entry) => entry.kind === "removal")).toEqual([
        {
          kind: "removal",
          day: round.day,
          createdAt: expect.any(Number),
          playerId: target,
          reason: history,
        },
      ]);
    });
  }
});
