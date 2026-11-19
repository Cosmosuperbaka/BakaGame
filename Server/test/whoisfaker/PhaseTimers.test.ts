import { describe, expect, test } from "bun:test";

import type { TimerSeam } from "../../src/application/room/RoomTimers";
import { WhoIsFakerService } from "../../src/application/WhoIsFakerService";
import { EventLogger } from "../../src/infrastructure/EventLogger";
import type { WhoIsFakerRoomSnapshot } from "../../src/shared/Index";
import { TEST_ROOMS_ON } from "../TestRoomPolicy";
import { createConnection, createTestContext, execute, getLastEventPayload } from "../Helpers";
import { createRoom, joinPlayers, setMyRoleAs } from "./Fixtures";

/** 手动驱动的定时器接缝：只记录挂载与取消，到点由用例自己触发。 */
const manualTimers = () => {
  const entries: Array<{ fire: () => void; delayMs: number; cancelled: boolean }> = [];
  const setTimer: TimerSeam = (fire, delayMs) => {
    const entry = { fire, delayMs, cancelled: false };
    entries.push(entry);
    return {
      cancel: () => {
        entry.cancelled = true;
      },
    };
  };
  return { setTimer, entries, live: () => entries.filter((entry) => !entry.cancelled) };
};

const startTimer = (
  service: WhoIsFakerService,
  host: ReturnType<typeof createConnection>,
  durationSeconds = 60
) =>
  execute(service, host, {
    id: `timer-${durationSeconds}`,
    type: "game.startPhaseTimer",
    payload: { durationSeconds },
  });

const setupDescription = async () => {
  const timers = manualTimers();
  const context = createTestContext({ setTimer: timers.setTimer });
  const { host } = await createRoom(context.service, "Oblivionis");
  await execute(context.service, host, { id: "bots", type: "test.addBot", payload: { count: 4 } });
  await execute(context.service, host, {
    id: "jump",
    type: "test.jumpToPhase",
    payload: { phase: "description" },
  });
  return { ...context, host, timers };
};

const phaseOf = (host: ReturnType<typeof createConnection>) =>
  getLastEventPayload<WhoIsFakerRoomSnapshot>(host, "room.snapshot")?.status.phase;

/** 搭一局白板猜词：房主加三个机器人，一名真人被指定为白板，停在描述阶段。 */
const setupBlankPlayer = async () => {
  const timers = manualTimers();
  const context = createTestContext({ setTimer: timers.setTimer });
  const { service } = context;
  const { host, result: hostSeat } = await createRoom(service, "Oblivionis");
  const [player] = await joinPlayers(service, "Oblivionis", 1, "白板玩家");
  await execute(service, host, { id: "bots", type: "test.addBot", payload: { count: 3 } });
  await execute(service, host, {
    id: "jump-words",
    type: "test.jumpToPhase",
    payload: { phase: "wordSubmission" },
  });
  await execute(service, host, {
    id: "words",
    type: "game.submitWords",
    payload: { words: ["苹果", "香蕉"] },
  });
  await setMyRoleAs(service, host, hostSeat.playerId, player, "blank");
  return { ...context, host, player, timers };
};

describe("阶段定时器", () => {
  test("开启倒计时挂一个房间定时器；到点按调度时刻的阶段强制推进", async () => {
    const { service, host, timers } = await setupDescription();
    await startTimer(service, host, 60);

    expect(timers.live().map((entry) => entry.delayMs)).toEqual([60_000]);
    timers.live()[0].fire();
    await Bun.sleep(0);

    expect(phaseOf(host)).toBe("voting");
  });

  test("同房重开倒计时先清旧的，取消倒计时撤掉底层定时器", async () => {
    const { service, host, timers } = await setupDescription();
    await startTimer(service, host, 60);
    await startTimer(service, host, 120);

    expect(timers.entries.map((entry) => entry.cancelled)).toEqual([true, false]);
    expect(timers.live().map((entry) => entry.delayMs)).toEqual([120_000]);

    await execute(service, host, { id: "stop", type: "game.stopPhaseTimer", payload: {} });
    expect(timers.live()).toEqual([]);
  });

  test("白板猜词打断发言阶段：暂停底层倒计时，裁定未通过后按剩余时间重新挂上", async () => {
    const { service, advanceTime, host, player, timers } = await setupBlankPlayer();
    await startTimer(service, host, 60);
    advanceTime(20_000);

    await execute(service, player.connection, {
      id: "enter",
      type: "game.enterBlankGuess",
      payload: {},
    });
    expect(timers.live()).toEqual([]);

    await execute(service, player.connection, {
      id: "guess",
      type: "game.submitBlankGuess",
      payload: { words: ["西瓜", "草莓"] },
    });
    await execute(service, host, {
      id: "review",
      type: "game.reviewBlankGuess",
      payload: { approve: false },
    });
    // 先停在猜词反馈：这时不挂倒计时，继续后才按被打断时的剩余时间恢复。
    expect(timers.live()).toEqual([]);
    await execute(service, host, { id: "continue", type: "game.advancePhase", payload: {} });

    expect(timers.live().map((entry) => entry.delayMs)).toEqual([40_000]);
    timers.live()[0].fire();
    await Bun.sleep(0);
    expect(phaseOf(player.connection)).toBe("voting");
  });

  test("白板掉线且出题人选择等待：挂上 60 秒兜底定时器，到点收口猜词阶段", async () => {
    const { service, host, player, timers } = await setupBlankPlayer();
    await execute(service, player.connection, {
      id: "enter",
      type: "game.enterBlankGuess",
      payload: {},
    });
    await service.unregisterConnection(player.connection.record.id);
    expect(timers.live()).toEqual([]);

    await execute(service, host, {
      id: "wait",
      type: "game.resolveDisconnect",
      payload: { playerId: player.joinResult.playerId, resolution: "wait" },
    });
    expect(timers.live().map((entry) => entry.delayMs)).toEqual([60_000]);

    timers.live()[0].fire();
    await Bun.sleep(0);
    expect(phaseOf(host)).toBe("feedback");
  });

  test("快照恢复：倒计时按停机时长后移并重新挂上，同号房间被跳过时不留孤儿定时器", async () => {
    const source = await setupDescription();
    await startTimer(source.service, source.host, 60);
    const savedAt = Date.UTC(2026, 3, 10, 0, 0, 0);
    const snapshots = source.service.exportSnapshots();

    const restoredTimers = manualTimers();
    const restarted = createTestContext({ setTimer: restoredTimers.setTimer });
    restarted.setTime(savedAt + 30_000);
    expect(restarted.service.restoreSnapshots(snapshots, savedAt)).toBe(1);

    // 停机 30 秒不算倒计时：恢复时刻起仍剩原来的 60 秒。
    expect(restoredTimers.live().map((entry) => entry.delayMs)).toEqual([60_000]);

    // 同号房间已存在：第二次恢复被跳过，也不能为被跳过的房间挂定时器。
    expect(restarted.service.restoreSnapshots(source.service.exportSnapshots(), savedAt)).toBe(0);
    expect(restoredTimers.entries).toHaveLength(1);

    restoredTimers.live()[0].fire();
    await Bun.sleep(0);
    expect(restarted.service.rooms.get("Oblivionis")?.round?.phase).toBe("voting");
  });

  test("解散房间清掉本房全部定时器，迟到的回调不会推进已删除的房间", async () => {
    const { service, host, timers } = await setupDescription();
    await startTimer(service, host, 60);
    const armed = timers.live()[0];

    await service.adminCloseRoom("Oblivionis");

    expect(timers.live()).toEqual([]);
    armed.fire();
    await Bun.sleep(0);
    expect(service.rooms.has("Oblivionis")).toBe(false);
  });

  test("定时器回调失败不成为未处理异常：记一条带房号的错误日志", async () => {
    const errors: Array<[string, unknown, unknown]> = [];
    class RecordingLogger extends EventLogger {
      override error(message: string, context?: Record<string, unknown>) {
        errors.push([message, context?.roomId, context?.timer]);
        super.error(message, context);
      }
    }
    const timers = manualTimers();
    const service = new WhoIsFakerService({
      now: () => Date.UTC(2026, 3, 10),
      testRooms: TEST_ROOMS_ON,
      eventLogger: new RecordingLogger(),
      setTimer: timers.setTimer,
    });
    const host = createConnection(service, "host");
    await execute(service, host, {
      id: "create",
      type: "room.create",
      payload: {
        roomId: "Oblivionis",
        name: "测试房间",
        visibility: "public",
        allowSpectators: true,
        userName: "房主",
      },
    });
    await execute(service, host, { id: "bots", type: "test.addBot", payload: { count: 4 } });
    await execute(service, host, {
      id: "jump",
      type: "test.jumpToPhase",
      payload: { phase: "description" },
    });
    await startTimer(service, host, 60);

    // 到点推进时发布快照会写到这条连接：让它抛错，模拟推进过程中的异常。
    host.record.send = () => {
      throw new Error("连接异常");
    };
    timers.live()[0].fire();
    await Bun.sleep(0);

    expect(errors).toEqual([["房间定时器回调失败", "Oblivionis", "phase"]]);
  });

  test("缺省的真实定时器不拖住进程退出", async () => {
    const created: Array<{ hasRef(): boolean }> = [];
    const realSetTimeout = globalThis.setTimeout;
    globalThis.setTimeout = ((...args: Parameters<typeof setTimeout>) => {
      const handle = realSetTimeout(...args);
      created.push(handle as unknown as { hasRef(): boolean });
      return handle;
    }) as typeof setTimeout;
    try {
      const { service } = createTestContext();
      const { host } = await createRoom(service, "Oblivionis");
      await execute(service, host, { id: "bots", type: "test.addBot", payload: { count: 4 } });
      await execute(service, host, {
        id: "jump",
        type: "test.jumpToPhase",
        payload: { phase: "description" },
      });
      created.length = 0;
      await startTimer(service, host, 60);
      expect(created).toHaveLength(1);
      expect(created[0].hasRef()).toBe(false);
      await service.adminCloseRoom("Oblivionis");
    } finally {
      globalThis.setTimeout = realSetTimeout;
    }
  });
});
