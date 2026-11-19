import { act, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { CommandPolicy, GameSendCommand } from "@/lib/GameWs";
import { rejectedProtocol } from "@/lib/ProtocolFailure";
import { deferred } from "@/test/Deferred";
import { useCommandRunner } from "./UseCommandRunner";

type Spec = {
  alpha: { payload: { id: string }; ack: string };
  beta: { payload: { id: string }; ack: string };
  long: { payload: { id: string }; ack: string };
};
const POLICY: CommandPolicy<Spec> = { long: { timeout: 0, pollSync: true } };

const setup = (lock: "command" | "single", pollSync?: () => void) => {
  const send = vi.fn();
  const onError = vi.fn();
  const h = renderHook(() =>
    useCommandRunner<Spec>({
      send: send as unknown as GameSendCommand<Spec>,
      policy: POLICY,
      pollSync,
      onError,
      lock,
    })
  );
  return { send, onError, h };
};

describe("按命令名加锁（command）", () => {
  it("同一命令在途时重复调用被忽略，落定后解锁并回传 ack", async () => {
    const ack = deferred<string>();
    const { send, h } = setup("command");
    send.mockReturnValue(ack.promise);

    let first!: Promise<string | undefined>;
    act(() => {
      first = h.result.current.run("alpha", { id: "1" });
    });
    expect(h.result.current.isPending("alpha")).toBe(true);
    expect(h.result.current.busy).toBe(true);

    let repeat!: Promise<string | undefined>;
    act(() => {
      repeat = h.result.current.run("alpha", { id: "2" });
    });
    expect(send).toHaveBeenCalledOnce();
    await act(async () => expect(await repeat).toBeUndefined());

    await act(async () => ack.resolve("结果"));
    expect(await first).toBe("结果");
    expect(h.result.current.isPending("alpha")).toBe(false);
    expect(h.result.current.busy).toBe(false);

    send.mockResolvedValue("再来");
    await act(async () => expect(await h.result.current.run("alpha", { id: "3" })).toBe("再来"));
    expect(send).toHaveBeenCalledTimes(2);
  });

  it("不同命令互不阻塞，pending 各自登记、落定各自移除", async () => {
    const a = deferred<string>();
    const b = deferred<string>();
    const { send, h } = setup("command");
    send.mockImplementation((type: string) => (type === "alpha" ? a.promise : b.promise));

    act(() => {
      void h.result.current.run("alpha", { id: "1" });
      void h.result.current.run("beta", { id: "2" });
    });
    expect(send).toHaveBeenCalledTimes(2);
    expect([...h.result.current.pending].sort()).toEqual(["alpha", "beta"]);

    await act(async () => a.resolve("甲"));
    expect([...h.result.current.pending]).toEqual(["beta"]);
    expect(h.result.current.busy).toBe(true);
    await act(async () => b.resolve("乙"));
    expect(h.result.current.pending.size).toBe(0);
    expect(h.result.current.busy).toBe(false);
  });

  it("自定义键登记进行中态，pendingKey 指向唯一在途的键", async () => {
    const ack = deferred<string>();
    const { send, h } = setup("command");
    send.mockReturnValue(ack.promise);
    act(() => {
      void h.result.current.run("alpha", { id: "1" }, { key: "按钮甲" });
    });
    expect(h.result.current.isPending("按钮甲")).toBe(true);
    expect(h.result.current.isPending("alpha")).toBe(false);
    expect(h.result.current.pendingKey).toBe("按钮甲");
    await act(async () => ack.resolve("ok"));
    expect(h.result.current.pendingKey).toBeNull();
  });
});

describe("整体互斥（single）", () => {
  it("在途时再发任何命令都被挡住，落定后可再发", async () => {
    const ack = deferred<string>();
    const { send, h } = setup("single");
    send.mockReturnValue(ack.promise);
    act(() => {
      void h.result.current.run("alpha", { id: "1" });
      void h.result.current.run("beta", { id: "2" });
    });
    expect(send).toHaveBeenCalledOnce();
    expect(h.result.current.pendingKey).toBe("alpha");
    await act(async () => ack.resolve("ok"));
    send.mockResolvedValue("乙");
    await act(async () => expect(await h.result.current.run("beta", { id: "2" })).toBe("乙"));
    expect(send).toHaveBeenCalledTimes(2);
  });
});

describe("超时口径与发送形状", () => {
  it("策略表 timeout: 0 的命令带选项参，其余命令不带选项参", async () => {
    const { send, h } = setup("command");
    send.mockResolvedValue("ok");
    await act(async () => {
      await h.result.current.run("alpha", { id: "1" });
    });
    expect(send).toHaveBeenNthCalledWith(1, "alpha", { id: "1" });
    await act(async () => {
      await h.result.current.run("long", { id: "2" });
    });
    expect(send).toHaveBeenNthCalledWith(2, "long", { id: "2" }, { timeout: 0 });
  });

  it("无载荷只发命令名，不带载荷参与选项参", async () => {
    const { send, h } = setup("command");
    send.mockResolvedValue("ok");
    await act(async () => {
      await h.result.current.run("alpha");
    });
    expect(send).toHaveBeenNthCalledWith(1, "alpha");
  });
});

describe("失败出口与成功回调", () => {
  it("失败走注入的 onError 并带命令名，结果为 undefined，照样解锁", async () => {
    const failure = { code: "TIMEOUT", message: "超时" };
    const { send, onError, h } = setup("command");
    send.mockReturnValue(rejectedProtocol(failure));

    let failed!: Promise<string | undefined>;
    act(() => {
      failed = h.result.current.run("alpha", { id: "1" });
    });
    await act(async () => expect(await failed).toBeUndefined());
    expect(onError).toHaveBeenCalledExactlyOnceWith(failure, "alpha");
    expect(h.result.current.pending.size).toBe(0);

    send.mockResolvedValue("重试成功");
    await act(async () =>
      expect(await h.result.current.run("alpha", { id: "1" })).toBe("重试成功")
    );
  });

  it("逐次 onError 优先于注入出口", async () => {
    const failure = { code: "FAIL", message: "本次失败" };
    const { send, onError, h } = setup("command");
    send.mockReturnValue(rejectedProtocol(failure));
    const own = vi.fn();
    await act(async () => {
      await h.result.current.run("alpha", { id: "1" }, { onError: own });
    });
    expect(own).toHaveBeenCalledExactlyOnceWith(failure);
    expect(onError).not.toHaveBeenCalled();
  });

  it("成功回调只在成功时执行，失败不执行", async () => {
    const { send, h } = setup("command");
    const onSuccess = vi.fn();
    send.mockResolvedValue("ok");
    await act(async () => {
      await h.result.current.run("alpha", { id: "1" }, { onSuccess });
    });
    expect(onSuccess).toHaveBeenCalledOnce();

    send.mockReturnValue(rejectedProtocol({ code: "FAIL", message: "失败" }));
    await act(async () => {
      await h.result.current.run("alpha", { id: "1" }, { onSuccess });
    });
    expect(onSuccess).toHaveBeenCalledOnce();
  });
});

describe("匿名动作 guard", () => {
  it("与命令共用整体互斥锁：guard 在途挡命令，命令在途挡 guard", async () => {
    const action = deferred<void>();
    const { send, h } = setup("single");
    send.mockResolvedValue("ok");
    let guarding!: Promise<void | undefined>;
    act(() => {
      guarding = h.result.current.guard(() => action.promise);
      void h.result.current.run("alpha", { id: "1" });
    });
    expect(send).not.toHaveBeenCalled();
    expect(h.result.current.busy).toBe(true);
    expect(h.result.current.pendingKey).toBeNull();
    await act(async () => {
      action.resolve();
      await guarding;
    });
    expect(h.result.current.busy).toBe(false);
    await act(async () => {
      await h.result.current.run("alpha", { id: "1" });
    });
    expect(send).toHaveBeenCalledOnce();

    const ack = deferred<string>();
    send.mockReturnValue(ack.promise);
    act(() => {
      void h.result.current.run("alpha", { id: "1" });
    });
    const blocked = vi.fn(async () => {});
    await act(async () => {
      await h.result.current.guard(blocked);
    });
    expect(blocked).not.toHaveBeenCalled();
    await act(async () => ack.resolve("ok"));
  });

  it("原样抛出动作错误并释放锁，允许失败后重试", async () => {
    const failure = new Error("动作失败");
    const { h } = setup("single");
    await act(async () => {
      await expect(h.result.current.guard(() => Promise.reject(failure))).rejects.toBe(failure);
    });
    expect(h.result.current.busy).toBe(false);
    const retry = vi.fn(async () => {});
    await act(async () => {
      await h.result.current.guard(retry);
    });
    expect(retry).toHaveBeenCalledOnce();
  });
});

describe("pollSync 命令在途期间的全量轮询", () => {
  afterEach(() => vi.useRealTimers());

  it("按间隔轮询，命令落定后停止", async () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
    const ack = deferred<string>();
    const pollSync = vi.fn();
    const { send, h } = setup("command", pollSync);
    send.mockReturnValue(ack.promise);
    act(() => {
      void h.result.current.run("long", { id: "1" });
    });
    expect(pollSync).not.toHaveBeenCalled();
    void act(() => vi.advanceTimersByTime(3_000));
    expect(pollSync).toHaveBeenCalledTimes(1);
    void act(() => vi.advanceTimersByTime(3_000));
    expect(pollSync).toHaveBeenCalledTimes(2);
    await act(async () => ack.resolve("ok"));
    void act(() => vi.advanceTimersByTime(9_000));
    expect(pollSync).toHaveBeenCalledTimes(2);
  });

  it("非 pollSync 命令在途不轮询", async () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
    const ack = deferred<string>();
    const pollSync = vi.fn();
    const { send, h } = setup("command", pollSync);
    send.mockReturnValue(ack.promise);
    act(() => {
      void h.result.current.run("alpha", { id: "1" });
    });
    void act(() => vi.advanceTimersByTime(9_000));
    expect(pollSync).not.toHaveBeenCalled();
    await act(async () => ack.resolve("ok"));
  });
});

describe("注入项的身份与新鲜度", () => {
  it("每轮换人也不改变 run 的身份，且取到最新的 onError", async () => {
    const stale = vi.fn();
    const fresh = vi.fn();
    const send = vi.fn().mockReturnValue(rejectedProtocol({ code: "FAIL", message: "失败" }));
    const h = renderHook(
      ({ onError }) =>
        useCommandRunner<Spec>({
          send: send as unknown as GameSendCommand<Spec>,
          policy: POLICY,
          onError,
          lock: "command",
        }),
      { initialProps: { onError: stale as (error: unknown, type: string) => void } }
    );
    const first = h.result.current.run;
    h.rerender({ onError: fresh });
    expect(h.result.current.run).toBe(first);
    await act(async () => {
      await h.result.current.run("alpha", { id: "1" });
    });
    expect(stale).not.toHaveBeenCalled();
    expect(fresh).toHaveBeenCalledOnce();
  });
});
