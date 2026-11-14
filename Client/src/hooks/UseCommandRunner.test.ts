import { act, renderHook } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { rejectedProtocol } from "@/lib/ProtocolFailure";
import { useCommandRunner } from "./UseCommandRunner";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

describe("useCommandRunner", () => {
  it("同一命令在途时重复调用被忽略，落定后解锁并回传结果", async () => {
    const ack = deferred<string>();
    const perform = vi.fn(() => ack.promise);
    const h = renderHook(() => useCommandRunner<string>({ onError: vi.fn() }));

    let first!: Promise<string | undefined>;
    act(() => {
      first = h.result.current.run("a", perform);
    });
    expect([...h.result.current.pending]).toEqual(["a"]);
    expect(h.result.current.busy).toBe(true);

    let repeat!: Promise<string | undefined>;
    act(() => {
      repeat = h.result.current.run("a", perform);
    });
    expect(perform).toHaveBeenCalledOnce();
    await act(async () => expect(await repeat).toBeUndefined());

    await act(async () => ack.resolve("结果"));
    expect(await first).toBe("结果");
    expect(h.result.current.pending.size).toBe(0);
    expect(h.result.current.busy).toBe(false);
  });

  it("不同命令互不阻塞，pending 只装仍在途的那些", async () => {
    const a = deferred<string>();
    const b = deferred<string>();
    const h = renderHook(() => useCommandRunner<string>({ onError: vi.fn() }));

    let runningA!: Promise<string | undefined>;
    let runningB!: Promise<string | undefined>;
    act(() => {
      runningA = h.result.current.run("a", () => a.promise);
      runningB = h.result.current.run("b", () => b.promise);
    });
    expect([...h.result.current.pending].sort()).toEqual(["a", "b"]);

    await act(async () => a.resolve("甲"));
    expect(await runningA).toBe("甲");
    expect([...h.result.current.pending]).toEqual(["b"]);
    expect(h.result.current.busy).toBe(true);

    await act(async () => b.resolve("乙"));
    expect(await runningB).toBe("乙");
    expect(h.result.current.busy).toBe(false);
  });

  it("失败走 onError、结果为 undefined，并且照样解锁", async () => {
    const onError = vi.fn();
    const failure = { code: "TIMEOUT", message: "超时" };
    const h = renderHook(() => useCommandRunner<string>({ onError }));

    let failed!: Promise<string | undefined>;
    act(() => {
      failed = h.result.current.run("a", () => rejectedProtocol(failure));
    });
    await act(async () => expect(await failed).toBeUndefined());
    expect(onError).toHaveBeenCalledExactlyOnceWith(failure);
    expect(h.result.current.pending.size).toBe(0);

    // 解锁后同一命令可以再次发出。
    const retry = vi.fn(() => Promise.resolve("重试成功"));
    await act(async () => expect(await h.result.current.run("a", retry)).toBe("重试成功"));
    expect(retry).toHaveBeenCalledOnce();
  });

  it("onError 每轮换人也不改变 run 的身份", () => {
    const h = renderHook(({ onError }) => useCommandRunner<string>({ onError }), {
      initialProps: { onError: vi.fn() },
    });
    const first = h.result.current.run;
    h.rerender({ onError: vi.fn() });
    expect(h.result.current.run).toBe(first);
  });

  it("重渲染后取到最新的 onError", async () => {
    const stale = vi.fn();
    const fresh = vi.fn();
    const h = renderHook(({ onError }) => useCommandRunner<string>({ onError }), {
      initialProps: { onError: stale as (error: unknown) => void },
    });
    h.rerender({ onError: fresh });
    await act(async () => {
      await h.result.current.run("a", () => Promise.reject(new Error("失败")));
    });
    expect(stale).not.toHaveBeenCalled();
    expect(fresh).toHaveBeenCalledOnce();
  });
});
