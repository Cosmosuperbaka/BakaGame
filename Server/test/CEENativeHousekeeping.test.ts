import { afterEach, describe, expect, test } from "bun:test";
import { ceeTestHarness, character, type CEETestClient } from "./CEENativeFixtures";
import { deferred } from "./support/Deferred";
import { createTestConnection } from "./support/Connection";
import type { GameRecorder } from "../src/domain/GameRecord";
import type { EventLogger } from "../src/infrastructure/EventLogger";
import { ROOM_ID_TEST_MODE, type CEECharacterView } from "../src/shared/Index";
import {
  PLAYER_OFFLINE_CLEANUP_TIMEOUT_MS,
  ROOM_EMPTY_GRACE_PERIOD_MS,
  ROOM_IDLE_TIMEOUT_MS,
  SPECTATOR_OFFLINE_GRACE_MS,
} from "../src/config/Constants";
import type { SnapshottedRoom } from "../src/shared/RoomSnapshot";
import type { TimerSeam } from "../src/application/room/RoomTimers";

const active: ReturnType<typeof ceeTestHarness>[] = [];
const keep = (harness: ReturnType<typeof ceeTestHarness>) => {
  active.push(harness);
  return harness;
};
afterEach(() => {
  active.splice(0).forEach((harness) => harness.service.close());
});

/** 收集结构化日志的告警：巡检与恢复的失败出口。 */
const collectWarnings = () => {
  const warnings: Array<{ message: string; context?: Record<string, unknown> }> = [];
  const logger = {
    warn: (message: string, context?: Record<string, unknown>) =>
      warnings.push({ message, context }),
  } as unknown as EventLogger;
  return { warnings, logger };
};

const createPayload = (roomId: string, userName: string) =>
  ({
    source: "native",
    roomId,
    name: `房${roomId}`,
    userName,
    visibility: "public",
    allowSpectators: true,
  }) as const;

describe("CEE 巡检与回收", () => {
  test("0 分旁观者离线只短暂保留，参与者与有分数的旁观者仍按长保留", async () => {
    const h = keep(ceeTestHarness());
    const host = await h.create();
    const watcher = await h.join("旁观者");
    const scorer = await h.join("有分旁观者");
    const player = await h.join("参与者");
    await h.send(watcher, "cee.player.spectate", { spectator: true });
    await h.send(scorer, "cee.player.spectate", { spectator: true });
    h.service.state.rooms.get("1234")!.players.get(scorer.id!)!.score = 3;
    for (const client of [watcher, scorer, player])
      h.service.unregisterConnection(client.record.id);

    h.advance(SPECTATOR_OFFLINE_GRACE_MS - 1000);
    expect(h.snapshot(host).players).toHaveLength(4);
    h.advance(1000);
    expect(
      h
        .snapshot(host)
        .players.map((item) => item.name)
        .sort()
    ).toEqual(["参与者", "房主", "有分旁观者"].sort());
    h.advance(PLAYER_OFFLINE_CLEANUP_TIMEOUT_MS);
    expect(h.snapshot(host).players.map((item) => item.name)).toEqual(["房主"]);
  });

  test("测试房只豁免空房回收：没人也不关，但闲置超时照样回收", async () => {
    const h = keep(ceeTestHarness({}, undefined, { roomId: ROOM_ID_TEST_MODE }));
    const host = await h.create();
    h.service.unregisterConnection(host.record.id);
    // 先巡检一次让空房计时起算，再越过宽限。
    h.advance(1000);
    h.advance(ROOM_EMPTY_GRACE_PERIOD_MS + 1000);
    expect(h.service.getHealthSnapshot().roomCount).toBe(1);
    h.advance(ROOM_IDLE_TIMEOUT_MS);
    expect(h.service.getHealthSnapshot().roomCount).toBe(0);
  });

  test("有人在线的测试房闲置超时同样被回收，全员收到关闭事件", async () => {
    const h = keep(ceeTestHarness({}, undefined, { roomId: ROOM_ID_TEST_MODE }));
    const host = await h.create();
    h.advance(ROOM_IDLE_TIMEOUT_MS);
    expect(h.service.getHealthSnapshot().roomCount).toBe(0);
    expect(host.sent.some((packet) => packet.event === "cee.room.closed")).toBe(true);
  });

  test("一间房巡检时抛错只记日志，其余房间照常回收", async () => {
    const { warnings, logger } = collectWarnings();
    // 1234 号房关闭时记账抛错：模拟一间房的坏状态。
    const recorder: GameRecorder = {
      record() {},
      finishRoom(room) {
        if (room.roomId === "1234") throw new Error("记账失败");
      },
    };
    const h = keep(ceeTestHarness({}, undefined, { gameRecorder: recorder, eventLogger: logger }));
    await h.create("甲");
    const other = h.connect("乙");
    await h.send(other, "cee.room.create", createPayload("5678", "乙"), "5678");

    h.advance(ROOM_IDLE_TIMEOUT_MS);
    expect([...h.service.state.rooms.keys()]).toEqual(["1234"]);
    expect(warnings).toHaveLength(1);
    expect(warnings[0].context).toMatchObject({ roomId: "1234" });
  });

  test("关房时本房的猜测信号表随房间一起清掉", async () => {
    const h = keep(ceeTestHarness());
    const host = await h.create("房主");
    const guest = await h.join("猜题人");
    await h.configure(host, {});
    await h.chooseSetter(host, host.id!);
    await h.send(host, "cee.game.setAnswer", { characterId: 1, hints: [] });
    await h.guess(guest, 3);
    // 信号表是服务内部的旁表，没有对外出口：只能直接看它有没有跟着房间走。
    const signals = (h.service.state.recording as unknown as { guessSignals: Map<string, unknown> })
      .guessSignals;
    expect(signals.has("1234")).toBe(true);
    h.service.adminCloseRoom("1234");
    expect(signals.has("1234")).toBe(false);
  });
});

describe("CEE 公共帧", () => {
  /** 不克隆载荷的连接：才能看出同一份公共帧是不是被各连接共用。 */
  const rawClient = (h: ReturnType<typeof ceeTestHarness>, name: string): CEETestClient => {
    const sent: CEETestClient["sent"] = [];
    const record = createTestConnection(`${name}-${crypto.randomUUID()}`, {
      send: (payload) => sent.push(payload as CEETestClient["sent"][number]),
      sendStateSyncCalibration: (payload) => sent.push(payload as CEETestClient["sent"][number]),
    });
    h.service.registerConnection(record);
    return { record, sent, closed: [] };
  };

  test("同一次发布里公共快照帧只封一次，各人的私有态各自构造；校准路径同口径", async () => {
    const h = keep(ceeTestHarness());
    const host = rawClient(h, "房主");
    await h.send(host, "cee.room.create", createPayload("1234", "房主"));
    const clients = [host];
    for (const name of ["甲", "乙"]) {
      const client = rawClient(h, name);
      await h.send(client, "cee.room.join", { userName: name });
      clients.push(client);
    }
    const room = h.service.state.rooms.get("1234")!;
    for (const publish of [
      () => h.service.state.publishRoom(room),
      () => h.service.state.publishRoomCalibration(room),
    ]) {
      for (const client of clients) client.sent.length = 0;
      publish();
      const snapshots = clients.map((client) =>
        client.sent.filter((packet) => packet.event === "cee.room.snapshot")
      );
      const privates = clients.map((client) =>
        client.sent.filter((packet) => packet.event === "cee.game.privateState")
      );
      expect(snapshots.map((list) => list.length)).toEqual([1, 1, 1]);
      expect(new Set(snapshots.map((list) => list[0])).size).toBe(1);
      expect(new Set(privates.map((list) => list[0])).size).toBe(3);
      // 每条连接先收公共帧、再收自己的私有帧。
      expect(clients[0].sent.map((packet) => packet.event)).toEqual([
        "cee.room.snapshot",
        "cee.game.privateState",
      ]);
    }
  });
});

describe("CEE 快照恢复", () => {
  test("单间恢复失败只丢这一间并记日志，其余房间照常恢复", async () => {
    const before = keep(ceeTestHarness());
    await before.create("甲");
    const other = before.connect("乙");
    await before.send(other, "cee.room.create", createPayload("5678", "乙"), "5678");
    const rooms = JSON.parse(JSON.stringify(before.service.exportSnapshots())) as SnapshottedRoom[];
    // 1234 号房的回合表被写坏：还原标签持有者时会抛错。
    (rooms[0] as unknown as { round: unknown }).round = {
      units: {},
      characters: {},
      tagOwners: { 标签: 5 },
      pendingTagOwners: {},
    };

    const { warnings, logger } = collectWarnings();
    const after = keep(ceeTestHarness({}, undefined, { eventLogger: logger }));
    expect(after.service.restoreSnapshots(rooms, before.now())).toBe(1);
    expect([...after.service.state.rooms.keys()]).toEqual(["5678"]);
    expect(warnings).toHaveLength(1);
    expect(warnings[0].context).toMatchObject({ roomId: "1234" });
  });

  test("恢复出来的房间全员离线：宽限内有人回来就保留，没人回来按空房回收", async () => {
    const before = keep(ceeTestHarness());
    const host = await before.create();
    const rooms = JSON.parse(JSON.stringify(before.service.exportSnapshots())) as SnapshottedRoom[];

    const returned = keep(ceeTestHarness());
    returned.service.restoreSnapshots(rooms, before.now());
    returned.advance(ROOM_EMPTY_GRACE_PERIOD_MS - 1000);
    const back = returned.connect("房主回来");
    await returned.send(back, "cee.room.reconnect", { roomId: "1234", sessionToken: host.token! });
    returned.advance(ROOM_EMPTY_GRACE_PERIOD_MS);
    expect(returned.service.getHealthSnapshot().roomCount).toBe(1);

    const abandoned = keep(ceeTestHarness());
    abandoned.service.restoreSnapshots(rooms, before.now());
    abandoned.advance(0);
    abandoned.advance(ROOM_EMPTY_GRACE_PERIOD_MS);
    expect(abandoned.service.getHealthSnapshot().roomCount).toBe(0);
  });
});

/** 注入的定时器接缝：数得出还有几个没到点也没取消的定时器，也能手动让某一个到点。 */
const fakeTimers = () => {
  const pending = new Set<{ fire: () => void; delayMs: number }>();
  const setTimer: TimerSeam = (fire, delayMs) => {
    const timer = { fire, delayMs };
    pending.add(timer);
    return { cancel: () => pending.delete(timer) };
  };
  const fireNext = () => {
    const [timer] = pending;
    pending.delete(timer);
    timer.fire();
  };
  return { pending, setTimer, fireNext };
};

describe("CEE 房间定时器", () => {
  /** 房主指定自己为出题人：进入出题阶段，挂上 120 秒的出题截止。 */
  const answeringRoom = async (timers: ReturnType<typeof fakeTimers>) => {
    const h = keep(ceeTestHarness({}, undefined, { setTimer: timers.setTimer }));
    const host = await h.create("房主");
    const guest = await h.join("猜题人");
    await h.configure(host, {});
    await h.chooseSetter(host, host.id!);
    return { h, host, guest };
  };

  test("每间房只留一个定时器，到点后推进回合并重发快照", async () => {
    const timers = fakeTimers();
    const { h, host } = await answeringRoom(timers);
    expect(timers.pending.size).toBe(1);
    expect([...timers.pending][0].delayMs).toBe(120_000);
    expect(h.snapshot(host).phase).toBe("answering");

    h.passTime(120_001);
    timers.fireNext();
    expect(h.snapshot(host).phase).toBe("waiting");
    // 回到等待阶段后没有截止，不再挂定时器。
    expect(timers.pending.size).toBe(0);
  });

  test("后台关房后没有残留定时器", async () => {
    const timers = fakeTimers();
    const { h } = await answeringRoom(timers);
    expect(timers.pending.size).toBe(1);
    h.service.adminCloseRoom("1234");
    expect(timers.pending.size).toBe(0);
  });

  test("最后一人离开关房的同一次命令里不会为已关的房间重挂定时器", async () => {
    const timers = fakeTimers();
    const pendingAnswer = deferred<CEECharacterView>();
    const h = keep(
      ceeTestHarness({ chooseRandomCharacter: () => pendingAnswer.promise }, undefined, {
        setTimer: timers.setTimer,
      })
    );
    const host = await h.create("房主");
    const guest = await h.join("猜题人");
    await h.configure(host, {});
    await h.ready(guest);
    // 随机出题在等题库：房间处于带 30 秒截止的出题阶段，截止仍挂在房间对象上。
    const starting = h.send(host, "cee.game.start", {});
    await Promise.resolve();
    expect(timers.pending.size).toBe(1);
    await h.send(guest, "cee.room.leave", {});
    await h.send(host, "cee.room.leave", {});
    expect(h.service.getHealthSnapshot().roomCount).toBe(0);
    expect(timers.pending.size).toBe(0);
    pendingAnswer.resolve(character(1));
    await starting.catch(() => undefined);
    expect(timers.pending.size).toBe(0);
  });

  describe("在途命令期间关房并同号重建", () => {
    /**
     * 猜测命令在等题库时，房间被后台关掉，同一张标签页随即用同一个房号重建。
     * 旧命令随后以「本局已经结束」收尾，但收尾时拿在手里的仍是旧房间对象。
     */
    const closedAndRebuiltDuringGuess = async () => {
      const timers = fakeTimers();
      const pendingCharacter = deferred<CEECharacterView>();
      const h = keep(
        ceeTestHarness(
          {
            getCharacter: (id) =>
              id === 3 ? pendingCharacter.promise : Promise.resolve(character(id)),
          },
          undefined,
          { setTimer: timers.setTimer }
        )
      );
      const host = await h.create("房主");
      const guest = h.connect("猜题人");
      guest.record.tabKey = "同一张标签页";
      await h.send(guest, "cee.room.join", { userName: "猜题人" });
      await h.configure(host, { timeLimit: 60 });
      await h.chooseSetter(host, host.id!);
      await h.send(host, "cee.game.setAnswer", { characterId: 1, hints: [] });
      expect(h.snapshot(guest).phase).toBe("guessing");
      expect(timers.pending.size).toBe(1);

      const inFlight = h.guess(guest, 3).then(
        () => undefined,
        (error: unknown) => error
      );
      await Promise.resolve();
      h.service.adminCloseRoom("1234");
      expect(timers.pending.size).toBe(0);
      await h.send(guest, "cee.room.create", {
        source: "native",
        roomId: "1234",
        name: "新房间",
        userName: "猜题人",
        visibility: "public",
        allowSpectators: true,
      });
      expect(h.snapshot(guest).phase).toBe("waiting");
      expect(timers.pending.size).toBe(0);
      return { h, guest, timers, inFlight, release: () => pendingCharacter.resolve(character(3)) };
    };

    test("旧命令收尾后新房没有多出定时器，旧命令只得到「本局已经结束」", async () => {
      const { timers, inFlight, release } = await closedAndRebuiltDuringGuess();
      release();
      expect(await inFlight).toMatchObject({ code: "ROUND_CANCELLED" });
      expect(timers.pending.size).toBe(0);
    });

    test("旧命令收尾不会把旧房的快照发给新房，新房阶段不受影响", async () => {
      const { h, guest, inFlight, release } = await closedAndRebuiltDuringGuess();
      const framesBefore = guest.sent.length;
      release();
      await inFlight;
      expect(guest.sent.slice(framesBefore)).toEqual([]);
      expect(h.snapshot(guest).phase).toBe("waiting");
      expect(h.service.getHealthSnapshot().roomCount).toBe(1);
    });
  });

  test("服务关闭时清掉全部定时器", async () => {
    const timers = fakeTimers();
    const { h } = await answeringRoom(timers);
    expect(timers.pending.size).toBe(1);
    h.service.close();
    expect(timers.pending.size).toBe(0);
  });
});
