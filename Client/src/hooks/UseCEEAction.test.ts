import { act, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ceeWsClient } from "@/lib/CEEWs";
import { deferred } from "@/test/Deferred";
import { useCEEStore } from "@/stores/UseCEEStore";
import { useCEEAction } from "./UseCEEAction";

afterEach(() => {
  useCEEStore.getState().resetRoom();
  vi.restoreAllMocks();
});

describe("useCEEAction", () => {
  it("同一命令在途时重复点击被忽略，成功后解锁并回传 ack", async () => {
    const ack = deferred<Record<string, unknown>>();
    const send = vi.spyOn(ceeWsClient, "send").mockReturnValue(ack.promise);
    const h = renderHook(() => useCEEAction());

    let first!: Promise<unknown>;
    act(() => {
      first = h.result.current.run("cee.game.setAnswer", { characterId: 1, hints: [] });
    });
    expect([...h.result.current.pending]).toEqual(["cee.game.setAnswer"]);
    expect(h.result.current.busy).toBe(true);

    let repeat!: Promise<unknown>;
    act(() => {
      repeat = h.result.current.run("cee.game.setAnswer", { characterId: 2, hints: [] });
    });
    expect(send).toHaveBeenCalledOnce();
    await act(async () => expect(await repeat).toBeUndefined());

    await act(async () => ack.resolve({ accepted: true }));
    expect(await first).toEqual({ accepted: true });
    expect(h.result.current.pending.size).toBe(0);
    expect(h.result.current.busy).toBe(false);
    // 命令与载荷原样交给 store 的 sendCommand，服务端计时口径也由它补齐。
    expect(send).toHaveBeenCalledWith(
      "cee.game.setAnswer",
      { characterId: 1, hints: [] },
      { timeout: 0 }
    );
  });

  it("失败经统一上报落提示并拉起登录，解锁后可再次提交", async () => {
    const send = vi
      .spyOn(ceeWsClient, "send")
      .mockRejectedValueOnce({ code: "LOGIN_REQUIRED", message: "服务端原文" })
      .mockResolvedValue({ accepted: true });
    const h = renderHook(() => useCEEAction());
    const before = useCEEStore.getState().requestLoginAt;

    let failed!: Promise<unknown>;
    act(() => {
      failed = h.result.current.run("cee.game.setAnswer", { characterId: 1, hints: [] });
    });
    await act(async () => expect(await failed).toBeUndefined());
    expect(useCEEStore.getState().toasts[0]?.text).toBe("该房间要求登录后再创建、加入或旁观");
    expect(useCEEStore.getState().requestLoginAt).toBeGreaterThan(before);
    expect(h.result.current.pending.size).toBe(0);
    expect(h.result.current.busy).toBe(false);

    await act(async () =>
      expect(
        await h.result.current.run("cee.game.setAnswer", { characterId: 1, hints: [] })
      ).toEqual({ accepted: true })
    );
    expect(send).toHaveBeenCalledTimes(2);
  });
});
