import { act, renderHook } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { usePhaseAction } from "./UsePhaseAction";

function deferred() {
  let resolve!: () => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<void>((done, fail) => { resolve = done; reject = fail; });
  return { promise, resolve, reject };
}

describe("usePhaseAction", () => {
  it("同一同步批次的重复与冲突提交只执行首个命令，ACK后恢复可提交", async () => {
    const ack = deferred();
    const submit = vi.fn(() => ack.promise);
    const conflictingAction = vi.fn(async () => {});
    const { result } = renderHook(usePhaseAction);
    expect(result.current.busy).toBe(false);
    let first!: Promise<void>;
    let duplicate!: Promise<void>;
    let conflict!: Promise<void>;
    act(() => {
      // 在React提交busy之前连续调用，只有同步ref守卫能拦住第二条命令。
      first = result.current.run(submit);
      duplicate = result.current.run(submit);
      conflict = result.current.run(conflictingAction);
    });
    await act(async () => { await Promise.all([duplicate, conflict]); });
    expect(submit).toHaveBeenCalledTimes(1);
    expect(conflictingAction).not.toHaveBeenCalled();
    expect(result.current.busy).toBe(true);

    await act(async () => { ack.resolve(); await first; });
    expect(result.current.busy).toBe(false);
    await act(async () => { await result.current.run(conflictingAction); });
    expect(conflictingAction).toHaveBeenCalledTimes(1);
    expect(result.current.busy).toBe(false);
  });

  it("ACK拒绝保留原错误并释放锁，允许失败后重试", async () => {
    const ack = deferred();
    const failure = new Error("阶段命令被拒绝");
    const retry = vi.fn(async () => {});
    const { result } = renderHook(usePhaseAction);
    let pending!: Promise<void>;
    act(() => { pending = result.current.run(() => ack.promise); });
    expect(result.current.busy).toBe(true);
    const rejected = expect(pending).rejects.toBe(failure);
    await act(async () => { ack.reject(failure); await rejected; });
    expect(result.current.busy).toBe(false);
    await act(async () => { await result.current.run(retry); });
    expect(retry).toHaveBeenCalledTimes(1);
    expect(result.current.busy).toBe(false);
  });

  it("动作同步抛错也释放锁，不吞错或永久禁用阶段操作", async () => {
    const failure = new Error("提交前校验失败");
    const retry = vi.fn(async () => {});
    const { result } = renderHook(usePhaseAction);
    await act(async () => {
      await expect(result.current.run(() => { throw failure; })).rejects.toBe(failure);
    });
    expect(result.current.busy).toBe(false);
    await act(async () => { await result.current.run(retry); });
    expect(retry).toHaveBeenCalledTimes(1);
    expect(result.current.busy).toBe(false);
  });
});
