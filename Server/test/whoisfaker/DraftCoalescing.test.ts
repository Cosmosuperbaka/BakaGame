import { describe, expect, test } from "bun:test";

import type { TimerSeam } from "../../src/application/room/RoomTimers";
import type { WhoIsFakerRoomSnapshot } from "../../src/shared/WhoIsFaker";
import { createTestContext, execute, getEventPayloads, getLastEventPayload } from "../Helpers";
import { createRoom, joinPlayers, setMyRoleAs } from "./Fixtures";

// 白板猜词草稿是高频更新：每次都全房扇出，成本随人数增长，且只靠客户端自觉节流。
// 服务端把全房发布合并到窗口末尾，草稿值本身立刻落进房间状态。

/** 手动推进的定时器：只放行被点名的那一类（按延迟区分），其余留着不动。 */
const manualTimers = () => {
  const queue: Array<{ fire: () => void; delayMs: number; cancelled: boolean }> = [];
  const setTimer: TimerSeam = (fire, delayMs) => {
    const entry = { fire, delayMs, cancelled: false };
    queue.push(entry);
    return {
      cancel: () => {
        entry.cancelled = true;
      },
    };
  };
  return {
    setTimer,
    /** 触发所有延迟不超过上限的待决定时器（草稿合并窗口是百毫秒量级）。 */
    flushShort: () => {
      for (const entry of queue.splice(0)) {
        if (entry.cancelled) continue;
        if (entry.delayMs <= 1000) entry.fire();
        else queue.push(entry);
      }
    },
    pendingShort: () => queue.filter((entry) => !entry.cancelled && entry.delayMs <= 1000).length,
  };
};

describe("白板猜词草稿的发布合并", () => {
  const startBlankGuess = async () => {
    const timers = manualTimers();
    const { service } = createTestContext({ setTimer: timers.setTimer });
    const { host, result: hostSeat } = await createRoom(service, "Oblivionis");
    const [blank] = await joinPlayers(service, "Oblivionis", 1, "白板玩家");
    await execute(service, host, { id: "bots", type: "test.addBot", payload: { count: 3 } });
    await execute(service, host, {
      id: "jump",
      type: "test.jumpToPhase",
      payload: { phase: "wordSubmission" },
    });
    await execute(service, host, {
      id: "words",
      type: "game.submitWords",
      payload: { words: ["苹果", "香蕉"] },
    });
    await setMyRoleAs(service, host, hostSeat.playerId, blank, "blank");
    await execute(service, blank.connection, {
      id: "enter",
      type: "game.enterBlankGuess",
      payload: {},
    });
    const snapshot = () => getLastEventPayload<WhoIsFakerRoomSnapshot>(host, "room.snapshot")!;
    expect(snapshot().status.phase).toBe("blankGuess");
    const update = (words: [string, string]) =>
      execute(service, blank.connection, {
        id: `draft-${Math.random()}`,
        type: "game.updateBlankGuessDraft",
        payload: { words },
      });
    const snapshotCount = () => getEventPayloads<unknown>(host, "room.snapshot").length;
    return { service, host, blank, snapshot, update, snapshotCount, timers };
  };

  test("窗口内的多次更新只发布最后一次（尾沿），期间没有逐次扇出", async () => {
    const f = await startBlankGuess();
    const before = f.snapshotCount();
    for (const word of ["西", "西瓜", "西瓜皮", "西瓜皮子"])
      await expect(f.update([word, ""])).resolves.toEqual({ updated: true });
    // 窗口还没到：一个快照也没有发出，窗口里只挂着一个待发布。
    expect(f.snapshotCount()).toBe(before);
    expect(f.timers.pendingShort()).toBe(1);

    f.timers.flushShort();
    expect(f.snapshotCount()).toBe(before + 1);
    expect(f.snapshot().status.blankGuessDraft).toEqual(["西瓜皮子", ""]);
  });

  test("最终值不丢：窗口末尾发布的就是最后一次更新，窗口后的新更新另起一个窗口", async () => {
    const f = await startBlankGuess();
    await f.update(["甲", "乙"]);
    f.timers.flushShort();
    expect(f.snapshot().status.blankGuessDraft).toEqual(["甲", "乙"]);

    const before = f.snapshotCount();
    await f.update(["丙", "乙"]);
    await f.update(["丙", "丁"]);
    expect(f.timers.pendingShort()).toBe(1);
    f.timers.flushShort();
    expect(f.snapshotCount()).toBe(before + 1);
    expect(f.snapshot().status.blankGuessDraft).toEqual(["丙", "丁"]);
  });

  test("提交时直接带出最新草稿的结果，不必等合并窗口", async () => {
    const f = await startBlankGuess();
    await f.update(["西瓜", "草莓"]);
    await execute(f.service, f.blank.connection, {
      id: "submit",
      type: "game.submitBlankGuess",
      payload: { words: ["西瓜", "草莓"] },
    });
    expect(f.snapshot().status.blankGuessPendingReview).toBe(true);
    // 窗口晚到也无害：阶段已变，不会再按旧草稿发一次。
    const before = f.snapshotCount();
    f.timers.flushShort();
    expect(f.snapshotCount()).toBe(before);
  });
});
