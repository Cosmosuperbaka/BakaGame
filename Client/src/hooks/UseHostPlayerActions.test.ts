import { act, renderHook } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { useHostPlayerActions } from "./UseHostPlayerActions";

const deferred = () => {
  let resolve!: () => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<void>((res, rej) => {
    resolve = () => res();
    reject = rej;
  });
  return { promise, resolve, reject };
};

const setup = (
  lock: "shared" | "none",
  overrides: Partial<Parameters<typeof useHostPlayerActions>[0]> = {}
) => {
  const kick = overrides.kick ?? vi.fn(() => Promise.resolve());
  const transferHost = overrides.transferHost ?? vi.fn(() => Promise.resolve());
  const setSpectator = overrides.setSpectator ?? vi.fn(() => Promise.resolve());
  const onError = overrides.onError ?? vi.fn();
  const view = renderHook(() =>
    useHostPlayerActions({ kick, transferHost, setSpectator, onError, lock })
  );
  return { ...view, kick, transferHost, setSpectator, onError };
};

describe("useHostPlayerActions", () => {
  it("三个回调各自转交对应选项与参数", async () => {
    const { result, kick, transferHost, setSpectator } = setup("none");
    await act(async () => {
      result.current.kick("p1");
    });
    await act(async () => {
      result.current.transferHost("p2");
    });
    await act(async () => {
      result.current.setSpectator(true);
    });
    expect(kick).toHaveBeenCalledWith("p1");
    expect(transferHost).toHaveBeenCalledWith("p2");
    expect(setSpectator).toHaveBeenCalledWith(true);
  });

  it("shared：命令在途时 pending 为真，同一帧连点只发一条", async () => {
    const gate = deferred();
    const { result, kick } = setup("shared", { kick: vi.fn(() => gate.promise) });
    act(() => {
      result.current.kick("p1");
      result.current.kick("p2");
    });
    expect(kick).toHaveBeenCalledTimes(1);
    expect(kick).toHaveBeenCalledWith("p1");
    expect(result.current.pending).toBe(true);
    await act(async () => {
      gate.resolve();
    });
    expect(result.current.pending).toBe(false);
  });

  it("shared：踢人在途时转让也被挡，返回后恢复可用", async () => {
    const gate = deferred();
    const { result, transferHost } = setup("shared", { kick: vi.fn(() => gate.promise) });
    act(() => {
      result.current.kick("p1");
    });
    act(() => {
      result.current.transferHost("p2");
    });
    expect(transferHost).not.toHaveBeenCalled();
    await act(async () => {
      gate.resolve();
    });
    act(() => {
      result.current.transferHost("p2");
    });
    expect(transferHost).toHaveBeenCalledWith("p2");
  });

  it("shared：失败交给 onError 并释放锁", async () => {
    const kick = vi.fn().mockRejectedValueOnce(new Error("boom")).mockResolvedValue(undefined);
    const { result, onError } = setup("shared", { kick });
    await act(async () => {
      result.current.kick("p1");
    });
    expect(onError).toHaveBeenCalledWith(expect.any(Error));
    expect(result.current.pending).toBe(false);
    await act(async () => {
      result.current.kick("p2");
    });
    expect(kick).toHaveBeenCalledTimes(2);
  });

  it("none：连点两条都发，pending 恒为假", async () => {
    const gate = deferred();
    const { result, setSpectator } = setup("none", { setSpectator: vi.fn(() => gate.promise) });
    act(() => {
      result.current.setSpectator(true);
      result.current.setSpectator(true);
    });
    expect(setSpectator).toHaveBeenCalledTimes(2);
    expect(result.current.pending).toBe(false);
    await act(async () => {
      gate.resolve();
    });
  });

  it("none：失败交给 onError", async () => {
    const kick = vi.fn().mockRejectedValue(new Error("boom"));
    const { result, onError } = setup("none", { kick });
    await act(async () => {
      result.current.kick("p1");
    });
    expect(onError).toHaveBeenCalledWith(expect.any(Error));
  });
});
