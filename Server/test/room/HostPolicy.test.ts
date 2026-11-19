import { describe, expect, test } from "bun:test";

import {
  assertTransferTarget,
  healHostOnAttach,
  isHostSeated,
  pickNextHost,
  reassignHost,
  resolveHostGrace,
  startHostGrace,
  transferHost,
} from "../../src/application/room/HostPolicy";
import { HOST_RECONNECT_TIMEOUT_MS } from "../../src/config/Constants";
import { expectAppError, makeRoom, makeSeat, type KernelSeat } from "./RoomKernelFixtures";

const NOW = 10_000;
const INSIDE = NOW + 5_000;
const EXPIRED = NOW - 1;

/** 房主的八种状态：在线、宽限内、宽限已过、离线却没有截止、空缺、悬空、被踢、机器人。 */
type HostState =
  | "online"
  | "graceInside"
  | "graceExpired"
  | "offlineNoDeadline"
  | "vacant"
  | "dangling"
  | "kicked"
  | "bot";

/** 候选的五种情形：有在线真人（active 与更早入房的旁观者）、只有在线旁观者、只有离线成员、只有机器人、空。 */
type Candidates = "onlineHuman" | "spectatorOnly" | "offlineOnly" | "botsOnly" | "empty";

const buildHost = (
  state: HostState
): { seats: KernelSeat[]; hostId: string; deadline?: number } => {
  const host = makeSeat("H", { joinedAt: 0 });
  switch (state) {
    case "online":
      return { seats: [host], hostId: "H", deadline: INSIDE };
    case "graceInside":
      return { seats: [{ ...host, online: false }], hostId: "H", deadline: INSIDE };
    case "graceExpired":
      return { seats: [{ ...host, online: false }], hostId: "H", deadline: EXPIRED };
    case "offlineNoDeadline":
      return { seats: [{ ...host, online: false }], hostId: "H" };
    case "vacant":
      return { seats: [], hostId: "" };
    case "dangling":
      return { seats: [], hostId: "H" };
    case "kicked":
      return { seats: [{ ...host, online: false, membership: "kicked" }], hostId: "H" };
    case "bot":
      return { seats: [{ ...host, isBot: true }], hostId: "H" };
  }
};

const buildCandidates = (candidates: Candidates): KernelSeat[] => {
  switch (candidates) {
    case "onlineHuman":
      return [
        makeSeat("S", { membership: "spectator", joinedAt: 1 }),
        makeSeat("A", { joinedAt: 5 }),
        makeSeat("A2", { joinedAt: 9 }),
      ];
    case "spectatorOnly":
      return [makeSeat("S", { membership: "spectator", joinedAt: 1 })];
    case "offlineOnly":
      return [makeSeat("O", { online: false, joinedAt: 1 })];
    case "botsOnly":
      return [makeSeat("B", { isBot: true, joinedAt: 1 })];
    case "empty":
      return [];
  }
};

const scene = (state: HostState, candidates: Candidates) => {
  const host = buildHost(state);
  const seats = [...host.seats, ...buildCandidates(candidates)];
  const room = makeRoom(seats, {
    hostPlayerId: host.hostId,
    hostReconnectDeadlineAt: host.deadline,
  });
  return { room, seats };
};

// [房主状态, 候选, 巡检后房主, 是否报告变更, 巡检后截止]
const RESOLVE_TABLE: [HostState, Candidates, string, boolean, number | undefined][] = [
  ["online", "onlineHuman", "H", false, undefined],
  ["online", "spectatorOnly", "H", false, undefined],
  ["online", "offlineOnly", "H", false, undefined],
  ["online", "botsOnly", "H", false, undefined],
  ["online", "empty", "H", false, undefined],
  ["graceInside", "onlineHuman", "H", false, INSIDE],
  ["graceInside", "spectatorOnly", "H", false, INSIDE],
  ["graceInside", "offlineOnly", "H", false, INSIDE],
  ["graceInside", "botsOnly", "H", false, INSIDE],
  ["graceInside", "empty", "H", false, INSIDE],
  ["graceExpired", "onlineHuman", "A", true, undefined],
  ["graceExpired", "spectatorOnly", "S", true, undefined],
  ["graceExpired", "offlineOnly", "H", false, EXPIRED],
  ["graceExpired", "botsOnly", "H", false, EXPIRED],
  ["graceExpired", "empty", "H", false, EXPIRED],
  ["offlineNoDeadline", "onlineHuman", "A", true, undefined],
  ["offlineNoDeadline", "spectatorOnly", "S", true, undefined],
  ["offlineNoDeadline", "offlineOnly", "H", false, undefined],
  ["offlineNoDeadline", "botsOnly", "H", false, undefined],
  ["offlineNoDeadline", "empty", "H", false, undefined],
  ["vacant", "onlineHuman", "A", true, undefined],
  ["vacant", "spectatorOnly", "S", true, undefined],
  ["vacant", "offlineOnly", "", false, undefined],
  ["vacant", "botsOnly", "", false, undefined],
  ["vacant", "empty", "", false, undefined],
  ["dangling", "onlineHuman", "A", true, undefined],
  ["dangling", "spectatorOnly", "S", true, undefined],
  ["dangling", "offlineOnly", "", true, undefined],
  ["dangling", "botsOnly", "", true, undefined],
  ["dangling", "empty", "", true, undefined],
  ["kicked", "onlineHuman", "A", true, undefined],
  ["kicked", "spectatorOnly", "S", true, undefined],
  ["kicked", "offlineOnly", "", true, undefined],
  ["kicked", "botsOnly", "", true, undefined],
  ["kicked", "empty", "", true, undefined],
  ["bot", "onlineHuman", "A", true, undefined],
  ["bot", "spectatorOnly", "S", true, undefined],
  ["bot", "offlineOnly", "H", false, undefined],
  ["bot", "botsOnly", "H", false, undefined],
  ["bot", "empty", "H", false, undefined],
];

describe("房主策略：巡检改选 resolveHostGrace", () => {
  test.each(RESOLVE_TABLE)(
    "房主%s、候选%s → 房主 %p，变更 %p，截止 %p",
    (state, candidates, expectedHost, expectedChanged, expectedDeadline) => {
      const { room, seats } = scene(state, candidates);
      const outcome = resolveHostGrace(room, seats, NOW);
      expect(room.hostPlayerId).toBe(expectedHost);
      expect(outcome.changed).toBe(expectedChanged);
      expect(room.hostReconnectDeadlineAt).toBe(expectedDeadline);
      if (outcome.next) expect(outcome.next.id).toBe(expectedHost);
      if (expectedChanged && expectedHost) expect(outcome.next?.id).toBe(expectedHost);
    }
  );

  test("改选时报告卸任者，供玩法写公告", () => {
    const { room, seats } = scene("graceExpired", "onlineHuman");
    const outcome = resolveHostGrace(room, seats, NOW);
    expect(outcome.previous?.id).toBe("H");
    expect(outcome.next?.id).toBe("A");
  });

  test("座位容器是只能遍历一次的迭代器时照样工作", () => {
    const { room, seats } = scene("graceExpired", "onlineHuman");
    const map = new Map(seats.map((seat) => [seat.id, seat]));
    resolveHostGrace(room, map.values(), NOW);
    expect(room.hostPlayerId).toBe("A");
  });
});

// [房主状态, 回来的座位, 是否当选, 之后的房主]
const HEAL_TABLE: [HostState, "active" | "spectator" | "bot", boolean, string][] = [
  ["online", "active", false, "H"],
  ["graceInside", "active", false, "H"],
  ["graceExpired", "active", true, "R"],
  ["offlineNoDeadline", "active", true, "R"],
  ["vacant", "active", true, "R"],
  ["dangling", "active", true, "R"],
  ["kicked", "active", true, "R"],
  ["bot", "active", true, "R"],
  ["online", "spectator", false, "H"],
  ["graceInside", "spectator", false, "H"],
  ["graceExpired", "spectator", true, "R"],
  ["vacant", "spectator", true, "R"],
  ["dangling", "spectator", true, "R"],
  ["online", "bot", false, "H"],
  ["graceExpired", "bot", false, "H"],
  ["vacant", "bot", false, ""],
  ["dangling", "bot", false, "H"],
];

describe("房主策略：上线接任 healHostOnAttach", () => {
  test.each(HEAL_TABLE)("房主%s、回来的是%s → 当选 %p，房主 %p", (state, kind, became, host) => {
    const built = buildHost(state);
    const returning = makeSeat("R", {
      joinedAt: 50,
      membership: kind === "spectator" ? "spectator" : "active",
      isBot: kind === "bot",
    });
    const seats = [...built.seats, returning];
    const room = makeRoom(seats, {
      hostPlayerId: built.hostId,
      hostReconnectDeadlineAt: built.deadline,
    });
    expect(healHostOnAttach(room, seats, returning, NOW)).toBe(became);
    expect(room.hostPlayerId).toBe(host);
    if (became) expect(room.hostReconnectDeadlineAt).toBeUndefined();
  });

  test("回来的是房主本人：清掉重连截止，不算新当选", () => {
    const host = makeSeat("H");
    const room = makeRoom([host], { hostReconnectDeadlineAt: INSIDE });
    expect(healHostOnAttach(room, [host], host, NOW)).toBe(false);
    expect(room.hostPlayerId).toBe("H");
    expect(room.hostReconnectDeadlineAt).toBeUndefined();
  });

  test("空缺时回来的是旁观者而在线的正式玩家还在：按候选规则交给正式玩家", () => {
    const active = makeSeat("A", { joinedAt: 5 });
    const returning = makeSeat("R", { membership: "spectator", joinedAt: 1 });
    const room = makeRoom([active, returning], { hostPlayerId: "" });
    expect(healHostOnAttach(room, [active, returning], returning, NOW)).toBe(false);
    expect(room.hostPlayerId).toBe("A");
  });

  test("房主被移除而其余全离线 → 待选；离线成员回来 → 当场接任", () => {
    const host = makeSeat("H", { joinedAt: 0 });
    const first = makeSeat("O1", { online: false, joinedAt: 1 });
    const second = makeSeat("O2", { online: false, joinedAt: 2 });
    const room = makeRoom([host, first, second]);
    delete room.players.H;
    expect(reassignHost(room, Object.values(room.players))).toBeUndefined();
    expect(room.hostPlayerId).toBe("");
    // 巡检照常跑也选不到人，房间保持待选而不是悬空指向已离开的人。
    expect(resolveHostGrace(room, Object.values(room.players), NOW).changed).toBe(false);
    expect(room.hostPlayerId).toBe("");
    second.online = true;
    expect(healHostOnAttach(room, Object.values(room.players), second, NOW)).toBe(true);
    expect(room.hostPlayerId).toBe("O2");
  });
});

describe("房主策略：候选、移除后改选与宽限", () => {
  test("候选只挑在线真人：active 优先，同级按入房先后；离线、机器人、被踢不当选", () => {
    const seats = [
      makeSeat("late", { joinedAt: 9 }),
      makeSeat("early", { joinedAt: 3 }),
      makeSeat("spec", { membership: "spectator", joinedAt: 0 }),
      makeSeat("off", { online: false, joinedAt: -1 }),
      makeSeat("bot", { isBot: true, joinedAt: -2 }),
      makeSeat("kick", { membership: "kicked", joinedAt: -3 }),
    ];
    expect(pickNextHost(seats)?.id).toBe("early");
    expect(pickNextHost(seats.slice(2))?.id).toBe("spec");
    expect(pickNextHost(seats.slice(3))).toBeUndefined();
    expect(pickNextHost([])).toBeUndefined();
  });

  test("CEE 的待批准旁观也算非 active 一档，排在正式玩家之后", () => {
    const pending = makeSeat("P", { membership: "pendingSpectator", joinedAt: 0 });
    const active = makeSeat("A", { joinedAt: 5 });
    expect(pickNextHost([pending, active])?.id).toBe("A");
    expect(pickNextHost([pending])?.id).toBe("P");
  });

  test("移除后改选：现任仍在名册不动；被踢或已删除时改选，选不到置待选并清截止", () => {
    const host = makeSeat("H");
    const other = makeSeat("A", { joinedAt: 1 });
    const room = makeRoom([host, other]);
    expect(reassignHost(room, [host, other])).toBeUndefined();
    expect(room.hostPlayerId).toBe("H");

    host.membership = "kicked";
    room.hostReconnectDeadlineAt = INSIDE;
    expect(reassignHost(room, [host, other])?.id).toBe("A");
    expect(room.hostPlayerId).toBe("A");
    expect(room.hostReconnectDeadlineAt).toBeUndefined();

    room.hostReconnectDeadlineAt = INSIDE;
    expect(reassignHost(room, [makeSeat("O", { online: false })])).toBeUndefined();
    expect(room.hostPlayerId).toBe("");
    expect(room.hostReconnectDeadlineAt).toBeUndefined();
  });

  test("房主掉线开始宽限：截止为当前时刻加重连时限", () => {
    const room = makeRoom([makeSeat("H")]);
    startHostGrace(room, NOW);
    expect(room.hostReconnectDeadlineAt).toBe(NOW + HOST_RECONNECT_TIMEOUT_MS);
  });

  test("房主在名册判定：空缺、悬空与被踢都不算", () => {
    const host = makeSeat("H");
    expect(isHostSeated(makeRoom([host]), [host])).toBe(true);
    expect(isHostSeated(makeRoom([host], { hostPlayerId: "" }), [host])).toBe(false);
    expect(isHostSeated(makeRoom([host], { hostPlayerId: "X" }), [host])).toBe(false);
    expect(isHostSeated(makeRoom([host]), [{ ...host, membership: "kicked" }])).toBe(false);
  });
});

describe("房主策略：手动转让", () => {
  test.each([
    ["不存在", undefined],
    ["离线", makeSeat("T", { online: false })],
    ["旁观者", makeSeat("T", { membership: "spectator" })],
    ["机器人", makeSeat("T", { isBot: true })],
    ["被踢", makeSeat("T", { membership: "kicked" })],
  ])("目标%s时拒绝", (_label, target) => {
    expectAppError(() => assertTransferTarget(target), "INVALID_TARGET");
  });

  test("错误码可按玩法现值传入；转让成功即清重连截止", () => {
    const host = makeSeat("H");
    const target = makeSeat("T");
    const room = makeRoom([host, target], { hostReconnectDeadlineAt: INSIDE });
    expectAppError(
      () =>
        transferHost(room, undefined, { code: "INVALID_PLAYER", message: "请选择在线参与玩家" }),
      "INVALID_PLAYER"
    );
    transferHost(room, target);
    expect(room.hostPlayerId).toBe("T");
    expect(room.hostReconnectDeadlineAt).toBeUndefined();
  });
});
