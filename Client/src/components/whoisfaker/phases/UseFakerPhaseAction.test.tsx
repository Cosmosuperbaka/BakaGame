import { act, renderHook } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { useWhoIsFakerStore } from "@/stores/UseWhoIsFakerStore";
import { deferred } from "@/test/Deferred";
import { useFakerPhaseAction } from "./UseFakerPhaseAction";

describe("usePhaseAction", () => {
  it("同一同步批次的重复与冲突提交只执行首个命令，ACK后恢复可提交", async () => {
    const ack = deferred();
    const submit = vi.fn(() => ack.promise);
    const conflictingAction = vi.fn(async () => {});
    const { result } = renderHook(useFakerPhaseAction);
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
    await act(async () => {
      await Promise.all([duplicate, conflict]);
    });
    expect(submit).toHaveBeenCalledTimes(1);
    expect(conflictingAction).not.toHaveBeenCalled();
    expect(result.current.busy).toBe(true);

    await act(async () => {
      ack.resolve();
      await first;
    });
    expect(result.current.busy).toBe(false);
    await act(async () => {
      await result.current.run(conflictingAction);
    });
    expect(conflictingAction).toHaveBeenCalledTimes(1);
    expect(result.current.busy).toBe(false);
  });

  it("ACK拒绝保留原错误并释放锁，允许失败后重试", async () => {
    const ack = deferred();
    const failure = new Error("阶段命令被拒绝");
    const retry = vi.fn(async () => {});
    const { result } = renderHook(useFakerPhaseAction);
    let pending!: Promise<void>;
    act(() => {
      pending = result.current.run(() => ack.promise);
    });
    expect(result.current.busy).toBe(true);
    const rejected = expect(pending).rejects.toBe(failure);
    await act(async () => {
      ack.reject(failure);
      await rejected;
    });
    expect(result.current.busy).toBe(false);
    await act(async () => {
      await result.current.run(retry);
    });
    expect(retry).toHaveBeenCalledTimes(1);
    expect(result.current.busy).toBe(false);
  });

  it("动作同步抛错也释放锁，不吞错或永久禁用阶段操作", async () => {
    const failure = new Error("提交前校验失败");
    const retry = vi.fn(async () => {});
    const { result } = renderHook(useFakerPhaseAction);
    await act(async () => {
      await expect(
        result.current.run(() => {
          throw failure;
        })
      ).rejects.toBe(failure);
    });
    expect(result.current.busy).toBe(false);
    await act(async () => {
      await result.current.run(retry);
    });
    expect(retry).toHaveBeenCalledTimes(1);
    expect(result.current.busy).toBe(false);
  });

  describe("exec", () => {
    const setup = (sendCommand: ReturnType<typeof vi.fn>) => {
      const addToast = vi.fn();
      useWhoIsFakerStore.setState({
        sendCommand: sendCommand as never,
        addToast,
      });
      return { addToast, hook: renderHook(useFakerPhaseAction) };
    };

    it("发命令期间登记在等哪个命令，完成后清空并执行成功回调", async () => {
      const ack = deferred();
      const send = vi.fn(() => ack.promise);
      const { hook } = setup(send);
      const onSuccess = vi.fn();
      let done!: Promise<void>;
      act(() => {
        done = hook.result.current.exec("game.advancePhase", undefined, {
          key: "advance",
          onSuccess,
        });
      });
      expect(hook.result.current.pending).toBe("advance");
      expect(hook.result.current.busy).toBe(true);
      await act(async () => {
        ack.resolve();
        await done;
      });
      expect(send).toHaveBeenCalledExactlyOnceWith("game.advancePhase");
      expect(hook.result.current.pending).toBeNull();
      expect(hook.result.current.busy).toBe(false);
      expect(onSuccess).toHaveBeenCalledTimes(1);
    });

    it("键默认取命令名，载荷原样透传", async () => {
      const ack = deferred();
      const { hook } = setup(vi.fn(() => ack.promise));
      let done!: Promise<void>;
      act(() => {
        done = hook.result.current.exec("game.submitVote", { targetId: "p1" });
      });
      expect(hook.result.current.pending).toBe("game.submitVote");
      await act(async () => {
        ack.resolve();
        await done;
      });
    });

    it("失败落成错误提示且不抛出、不执行成功回调，随后可重试", async () => {
      const send = vi.fn().mockRejectedValueOnce({ message: "阶段已变化" }).mockResolvedValue({});
      const { hook, addToast } = setup(send);
      const onSuccess = vi.fn();
      await act(async () => {
        await hook.result.current.exec("game.advancePhase", undefined, { onSuccess });
      });
      expect(addToast).toHaveBeenCalledExactlyOnceWith("阶段已变化", "error");
      expect(onSuccess).not.toHaveBeenCalled();
      expect(hook.result.current.pending).toBeNull();
      await act(async () => {
        await hook.result.current.exec("game.advancePhase", undefined, { onSuccess });
      });
      expect(onSuccess).toHaveBeenCalledTimes(1);
    });

    it("错误没有文案时用兜底提示", async () => {
      const { hook, addToast } = setup(vi.fn().mockRejectedValue({}));
      await act(async () => {
        await hook.result.current.exec("game.advancePhase", undefined, {
          fallback: "返回房间失败",
        });
      });
      expect(addToast).toHaveBeenCalledWith("返回房间失败", "error");
    });

    it("在途时再发任何命令都被同一把锁挡住", async () => {
      const ack = deferred();
      const send = vi.fn(() => ack.promise);
      const { hook } = setup(send);
      let first!: Promise<void>;
      act(() => {
        first = hook.result.current.exec("game.advancePhase");
        void hook.result.current.exec("game.cancelVote");
      });
      expect(send).toHaveBeenCalledTimes(1);
      await act(async () => {
        ack.resolve();
        await first;
      });
    });
  });
});
