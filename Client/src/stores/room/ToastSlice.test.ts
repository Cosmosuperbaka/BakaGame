import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { create } from "zustand";
import { createToastSlice, type ToastSliceOptions, type ToastState } from "./ToastSlice";

const createHost = (options: ToastSliceOptions) =>
  create<ToastState>((set) => createToastSlice(set, options));

const queueHost = () => createHost({ mode: "queue", defaultType: "info", defaultMs: 3000 });
const slotHost = () => createHost({ mode: "slot", defaultType: "error", defaultMs: 5000 });

const texts = (host: ReturnType<typeof createHost>) =>
  host.getState().toasts.map((item) => item.text);

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
});

describe("提示切片：队列模式", () => {
  it("多条并存，编号互不相同", () => {
    const host = queueHost();
    host.getState().showToast("甲");
    host.getState().showToast("乙", "error");
    expect(host.getState().toasts.map((item) => [item.text, item.type])).toEqual([
      ["甲", "info"],
      ["乙", "error"],
    ]);
    expect(new Set(host.getState().toasts.map((item) => item.id)).size).toBe(2);
  });

  it("同一句话连发也各自成条", () => {
    const host = queueHost();
    host.getState().showToast("同一句");
    host.getState().showToast("同一句");
    expect(texts(host)).toEqual(["同一句", "同一句"]);
    expect(new Set(host.getState().toasts.map((item) => item.id)).size).toBe(2);
  });

  it("每条各自计时，到点的先消失", () => {
    const host = queueHost();
    host.getState().showToast("先发的");
    vi.advanceTimersByTime(1000);
    host.getState().showToast("后发的");
    vi.advanceTimersByTime(2000);
    expect(texts(host)).toEqual(["后发的"]);
    vi.advanceTimersByTime(1000);
    expect(texts(host)).toEqual([]);
  });

  it("dismissToast 只摘掉指定的一条", () => {
    const host = queueHost();
    host.getState().showToast("甲");
    host.getState().showToast("乙");
    host.getState().dismissToast(host.getState().toasts[0].id);
    expect(texts(host)).toEqual(["乙"]);
  });

  it("clearToasts 清空全部提示", () => {
    const host = queueHost();
    host.getState().showToast("甲");
    host.getState().showToast("乙");
    host.getState().clearToasts();
    expect(texts(host)).toEqual([]);
    vi.advanceTimersByTime(3000);
    expect(texts(host)).toEqual([]);
  });

  it("默认类型与默认时长取 options，手动时长优先", () => {
    const host = createHost({ mode: "queue", defaultType: "success", defaultMs: 1200 });
    host.getState().showToast("按配置");
    host.getState().showToast("手动时长", "error", 500);
    expect(host.getState().toasts.map((item) => item.type)).toEqual(["success", "error"]);
    vi.advanceTimersByTime(500);
    expect(texts(host)).toEqual(["按配置"]);
    vi.advanceTimersByTime(699);
    expect(texts(host)).toEqual(["按配置"]);
    vi.advanceTimersByTime(1);
    expect(texts(host)).toEqual([]);
  });
});

describe("提示切片：单槽模式", () => {
  it("新提示顶掉旧提示，只留一条", () => {
    const host = slotHost();
    host.getState().showToast("甲");
    host.getState().showToast("乙", "success");
    expect(host.getState().toasts.map((item) => [item.text, item.type])).toEqual([
      ["乙", "success"],
    ]);
  });

  it("编号取类型加冒号加文字", () => {
    const host = slotHost();
    host.getState().showToast("密码错误");
    expect(host.getState().toasts[0].id).toBe("error:密码错误");
  });

  it("同一句话连发编号不变，换文字或换类型才换编号", () => {
    const host = slotHost();
    host.getState().showToast("轮到你了", "info");
    const first = host.getState().toasts[0].id;
    host.getState().showToast("轮到你了", "info");
    expect(host.getState().toasts[0].id).toBe(first);
    host.getState().showToast("轮到别人了", "info");
    expect(host.getState().toasts[0].id).not.toBe(first);
    host.getState().showToast("轮到你了", "error");
    expect(host.getState().toasts[0].id).not.toBe(first);
    expect(texts(host)).toEqual(["轮到你了"]);
  });

  it("新提示取消旧计时，按最后一次的时长消失", () => {
    const host = slotHost();
    host.getState().showToast("同一句", "error", 1000);
    vi.advanceTimersByTime(900);
    host.getState().showToast("同一句", "error", 5000);
    vi.advanceTimersByTime(100);
    expect(texts(host)).toEqual(["同一句"]);
    vi.advanceTimersByTime(4900);
    expect(texts(host)).toEqual([]);
  });

  it("clearToasts 清空并取消计时", () => {
    const host = slotHost();
    host.getState().showToast("同一句", "error", 1000);
    host.getState().clearToasts();
    expect(texts(host)).toEqual([]);
    expect(vi.getTimerCount()).toBe(0);
    host.getState().showToast("同一句", "error", 5000);
    vi.advanceTimersByTime(1000);
    expect(texts(host)).toEqual(["同一句"]);
  });

  it("dismissToast 摘掉单槽里的那一条", () => {
    const host = slotHost();
    host.getState().showToast("甲");
    host.getState().dismissToast(host.getState().toasts[0].id);
    expect(texts(host)).toEqual([]);
  });

  it("手动摘掉后旧计时作废，同一句话重发按新时长停留", () => {
    const host = slotHost();
    host.getState().showToast("同一句", "error", 1000);
    host.getState().dismissToast("error:同一句");
    expect(vi.getTimerCount()).toBe(0);
    host.getState().showToast("同一句", "error", 5000);
    vi.advanceTimersByTime(1000);
    expect(texts(host)).toEqual(["同一句"]);
  });

  it("默认类型与默认时长取 options", () => {
    const host = createHost({ mode: "slot", defaultType: "info", defaultMs: 3000 });
    host.getState().showToast("按配置");
    expect(host.getState().toasts.map((item) => item.type)).toEqual(["info"]);
    vi.advanceTimersByTime(2999);
    expect(texts(host)).toEqual(["按配置"]);
    vi.advanceTimersByTime(1);
    expect(texts(host)).toEqual([]);
  });
});
