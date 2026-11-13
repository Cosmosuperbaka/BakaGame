import { beforeEach, describe, expect, it, vi } from "vitest";
import { createRoomEntry } from "./RoomEntry";

/** 手动落定的 Promise：用来把「请求在途」的窗口卡在测试想要的位置。 */
const deferred = <T>() => {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
};

const flush = async () => {
  for (let index = 0; index < 10; index += 1) await Promise.resolve();
};

let generation = 0;
const begin = vi.fn<() => void>();
const apply = vi.fn<(receipt: string) => void>();
const discard = vi.fn<(receipt: string) => Promise<void>>(async () => undefined);

const entry = () =>
  createRoomEntry<string>({ generation: () => generation, begin, apply, discard });

const never = () => false;

beforeEach(() => {
  generation = 0;
  begin.mockClear();
  apply.mockClear();
  discard.mockClear();
});

describe("入房事务", () => {
  it("两次入房串行：前一次落定后后一次才发请求，回执按顺序提交", async () => {
    const room = entry();
    const first = deferred<string>();
    const second = deferred<string>();
    const requestFirst = vi.fn(() => first.promise);
    const requestSecond = vi.fn(() => second.promise);

    const firstDone = room.enter(requestFirst);
    const secondDone = room.enter(requestSecond);
    await flush();
    expect(requestFirst).toHaveBeenCalledTimes(1);
    expect(requestSecond).not.toHaveBeenCalled();
    expect(room.isPending()).toBe(true);

    first.resolve("A");
    await firstDone;
    await flush();
    expect(apply).toHaveBeenNthCalledWith(1, "A");
    expect(requestSecond).toHaveBeenCalledTimes(1);

    second.resolve("B");
    await secondDone;
    expect(apply).toHaveBeenNthCalledWith(2, "B");
    expect(begin).toHaveBeenCalledTimes(2);
    expect(room.isPending()).toBe(false);
  });

  it("请求在途时取消：回执到达后先退掉这个已确认的座位，不提交，入房以取消结束", async () => {
    const room = entry();
    const ack = deferred<string>();
    const done = room.enter(() => ack.promise);
    const rejection = expect(done).rejects.toMatchObject({ name: "AbortError" });

    room.cancel();
    ack.resolve("A");
    await rejection;

    expect(discard).toHaveBeenCalledExactlyOnceWith("A");
    expect(apply).not.toHaveBeenCalled();
  });

  it("取消之后的新入房不受旧生命周期牵连，照常提交；旧回执晚到时被退掉", async () => {
    const room = entry();
    const stale = deferred<string>();
    const staleDone = room.enter(() => stale.promise);
    const staleRejection = expect(staleDone).rejects.toMatchObject({ name: "AbortError" });
    room.cancel();

    const fresh = room.enter(async () => "fresh");
    stale.resolve("old");
    await staleRejection;
    await fresh;

    expect(apply).toHaveBeenCalledExactlyOnceWith("fresh");
    expect(discard).toHaveBeenCalledExactlyOnceWith("old");
  });

  it("连接代次变化后到达的回执既不提交也不退房，也不向新连接发旧退房", async () => {
    const room = entry();
    const ack = deferred<string>();
    const done = room.enter(() => ack.promise);
    const rejection = expect(done).rejects.toMatchObject({ name: "AbortError" });

    generation += 1;
    ack.resolve("A");
    await rejection;

    expect(apply).not.toHaveBeenCalled();
    expect(discard).not.toHaveBeenCalled();
  });

  it("过期响应：调用方的取消信号在回执前触发，回执被丢弃并退房", async () => {
    const room = entry();
    const controller = new AbortController();
    const ack = deferred<string>();
    const done = room.enter(() => ack.promise, controller.signal);
    const rejection = expect(done).rejects.toMatchObject({ name: "AbortError" });

    controller.abort();
    ack.resolve("A");
    await rejection;

    expect(discard).toHaveBeenCalledExactlyOnceWith("A");
    expect(apply).not.toHaveBeenCalled();
  });

  it("取消信号在请求发出之前就已触发：连请求都不发", async () => {
    const room = entry();
    const controller = new AbortController();
    controller.abort();
    const request = vi.fn(async () => "A");

    await expect(room.enter(request, controller.signal)).rejects.toMatchObject({
      name: "AbortError",
    });
    expect(request).not.toHaveBeenCalled();
    expect(begin).not.toHaveBeenCalled();
  });

  it("请求失败原样抛出，队列照常放行下一次", async () => {
    const room = entry();
    await expect(
      room.enter(async () => {
        throw new Error("房间不存在");
      })
    ).rejects.toThrow("房间不存在");
    expect(room.isPending()).toBe(false);

    await room.enter(async () => "B");
    expect(apply).toHaveBeenCalledExactlyOnceWith("B");
  });

  it("restore：同键同代次的并发恢复共享一次请求，结果一致", async () => {
    const room = entry();
    const ack = deferred<string>();
    const request = vi.fn(() => ack.promise);

    const first = room.restore("room-1", request, never);
    const second = room.restore("room-1", request, never);
    ack.resolve("A");

    await expect(Promise.all([first, second])).resolves.toEqual([true, true]);
    expect(request).toHaveBeenCalledTimes(1);
    expect(apply).toHaveBeenCalledExactlyOnceWith("A");
  });

  it("restore：不同的键各发各的请求", async () => {
    const room = entry();
    const first = room.restore("room-1", async () => "A", never);
    const second = room.restore("room-2", async () => "B", never);
    await Promise.all([first, second]);
    expect(apply.mock.calls.map(([receipt]) => receipt)).toEqual(["A", "B"]);
  });

  it("restore：所有参与者都放弃才算放弃，只要还有人要就照常提交", async () => {
    const room = entry();
    const ack = deferred<string>();
    const gone = new AbortController();
    const kept = new AbortController();
    const first = room.restore("room-1", () => ack.promise, never, gone.signal);
    const second = room.restore("room-1", () => ack.promise, never, kept.signal);
    const firstRejection = expect(first).rejects.toMatchObject({ name: "AbortError" });

    gone.abort();
    ack.resolve("A");

    await firstRejection;
    await expect(second).resolves.toBe(true);
    expect(apply).toHaveBeenCalledExactlyOnceWith("A");
    expect(discard).not.toHaveBeenCalled();
  });

  it("restore：全部参与者都放弃时回执被退掉，不提交", async () => {
    const room = entry();
    const ack = deferred<string>();
    const one = new AbortController();
    const two = new AbortController();
    const first = room.restore("room-1", () => ack.promise, never, one.signal);
    const second = room.restore("room-1", () => ack.promise, never, two.signal);
    const settled = Promise.allSettled([first, second]);

    one.abort();
    two.abort();
    ack.resolve("A");
    const results = await settled;

    expect(results.map((result) => result.status)).toEqual(["rejected", "rejected"]);
    expect(discard).toHaveBeenCalledExactlyOnceWith("A");
    expect(apply).not.toHaveBeenCalled();
  });

  it("restore：失败经 onFailure 判为已处理时返回 false 不抛出；判为未处理则原样抛出", async () => {
    const room = entry();
    const handled = vi.fn(() => true);
    await expect(
      room.restore(
        "room-1",
        async () => {
          throw new Error("临时失败");
        },
        handled
      )
    ).resolves.toBe(false);
    expect(handled).toHaveBeenCalledTimes(1);
    expect(apply).not.toHaveBeenCalled();

    await expect(
      room.restore(
        "room-1",
        async () => {
          throw new Error("未处理的失败");
        },
        never
      )
    ).rejects.toThrow("未处理的失败");
  });

  it("restore 落定后同键再来是新的一次；cancel 之后同键也重新发请求（重入）", async () => {
    const room = entry();
    const request = vi.fn(async () => "A");

    await room.restore("room-1", request, never);
    await room.restore("room-1", request, never);
    expect(request).toHaveBeenCalledTimes(2);

    const slow = deferred<string>();
    const pending = room.restore("room-2", () => slow.promise, never);
    const pendingRejection = expect(pending).rejects.toMatchObject({ name: "AbortError" });
    room.cancel();
    // 新的恢复排在已放弃的那次之后：旧请求落定（并退房）后才轮到它。
    const again = room.restore("room-2", request, never);
    await flush();
    expect(request).toHaveBeenCalledTimes(2);
    slow.resolve("old");
    await pendingRejection;
    await again;
    expect(request).toHaveBeenCalledTimes(3);
    expect(discard).toHaveBeenCalledExactlyOnceWith("old");
  });

  it("restore：代次变化后同键不再共享旧的在途恢复", async () => {
    const room = entry();
    const ack = deferred<string>();
    const stale = room.restore("room-1", () => ack.promise, never);
    const staleRejection = expect(stale).rejects.toMatchObject({ name: "AbortError" });

    generation += 1;
    const fresh = vi.fn(async () => "B");
    const freshDone = room.restore("room-1", fresh, never);
    // 同键但代次已变：不并入旧的在途恢复，而是另起一次（仍排在旧请求之后串行）。
    ack.resolve("old");
    await staleRejection;
    await freshDone;
    expect(fresh).toHaveBeenCalledTimes(1);
    expect(apply).toHaveBeenCalledExactlyOnceWith("B");
    expect(discard).not.toHaveBeenCalled();
  });
});
