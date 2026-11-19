import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { deferred } from "@/test/Deferred";
import { SerialSaveQueue } from "./SerialSaveQueue";
const make = (
  overrides: Partial<ConstructorParameters<typeof SerialSaveQueue<string>>[1]> = {}
) => {
  const save = vi.fn().mockResolvedValue(undefined);
  const queue = new SerialSaveQueue<string>("a", {
    save,
    delayMs: 100,
    enabled: true,
    ...overrides,
  });
  return { save, queue };
};

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

it("防抖后只提交最新草稿，与已保存值相同的草稿不提交", async () => {
  const { save, queue } = make();
  queue.setValue("b");
  queue.setValue("c");
  await vi.advanceTimersByTimeAsync(100);
  expect(save).toHaveBeenCalledExactlyOnceWith("c");
  queue.setValue("c");
  await vi.advanceTimersByTimeAsync(100);
  expect(save).toHaveBeenCalledTimes(1);
});

it("在途期间只保留最新草稿，收尾后接力提交且不并发", async () => {
  const first = deferred();
  const { save, queue } = make();
  save.mockReturnValueOnce(first.promise);
  queue.setValue("b");
  await vi.advanceTimersByTimeAsync(100);
  queue.setValue("c");
  queue.setValue("d");
  await vi.advanceTimersByTimeAsync(100);
  expect(save).toHaveBeenCalledTimes(1);
  first.resolve();
  await vi.advanceTimersByTimeAsync(100);
  expect(save.mock.calls.map(([value]) => value)).toEqual(["b", "d"]);
});

it("失败的值在再次编辑前不重试，并通知 onError", async () => {
  const onError = vi.fn();
  const { save, queue } = make({ onError });
  save.mockRejectedValueOnce(new Error("boom"));
  queue.setValue("b");
  await vi.advanceTimersByTimeAsync(100);
  expect(onError).toHaveBeenCalledTimes(1);
  queue.setValue("b");
  await vi.advanceTimersByTimeAsync(100);
  expect(save).toHaveBeenCalledTimes(1);
  queue.setValue("c");
  await vi.advanceTimersByTimeAsync(100);
  expect(save).toHaveBeenCalledTimes(2);
});

it("关闭后丢弃待提交草稿；在途保存收尾时也不再接力", async () => {
  const first = deferred();
  const config = { save: vi.fn().mockReturnValueOnce(first.promise), delayMs: 100, enabled: true };
  const queue = new SerialSaveQueue<string>("a", config);
  queue.setValue("b");
  await vi.advanceTimersByTimeAsync(100);
  queue.setValue("c");
  queue.configure({ ...config, enabled: false });
  queue.disable();
  first.resolve();
  await vi.advanceTimersByTimeAsync(1_000);
  expect(config.save).toHaveBeenCalledTimes(1);
});

it("卸载时立即冲刷最新草稿，卸载后在途期间产生的草稿收尾时立即提交", async () => {
  const first = deferred();
  const { save, queue } = make();
  save.mockReturnValueOnce(first.promise);
  queue.setValue("b");
  queue.unmount();
  expect(save).toHaveBeenCalledExactlyOnceWith("b");
  queue.setValue("c");
  first.resolve();
  await vi.advanceTimersByTimeAsync(0);
  expect(save.mock.calls.map(([value]) => value)).toEqual(["b", "c"]);
});
