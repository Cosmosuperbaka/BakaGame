import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { create } from "zustand";
import { TOAST_LIMIT, createToastSlice, type ToastState } from "./ToastSlice";

const createHost = () => create<ToastState>((set, get) => createToastSlice(set, get));

const texts = (host: ReturnType<typeof createHost>) =>
  host.getState().toasts.map((item) => item.text);

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
});

describe("提示切片：类型与停留时长", () => {
  it("默认是普通信息，停留三秒", () => {
    const host = createHost();
    host.getState().showToast("按默认");
    expect(host.getState().toasts.map((item) => item.type)).toEqual(["info"]);
    vi.advanceTimersByTime(2999);
    expect(texts(host)).toEqual(["按默认"]);
    vi.advanceTimersByTime(1);
    expect(texts(host)).toEqual([]);
  });

  it("成功同样停留三秒", () => {
    const host = createHost();
    host.getState().showToast("已保存", "success");
    vi.advanceTimersByTime(2999);
    expect(texts(host)).toEqual(["已保存"]);
    vi.advanceTimersByTime(1);
    expect(texts(host)).toEqual([]);
  });

  it("错误多停一会儿，停留五秒", () => {
    const host = createHost();
    host.getState().showToast("出错了", "error");
    vi.advanceTimersByTime(4999);
    expect(texts(host)).toEqual(["出错了"]);
    vi.advanceTimersByTime(1);
    expect(texts(host)).toEqual([]);
  });

  it("手动时长优先于按类型的默认值", () => {
    const host = createHost();
    host.getState().showToast("短错误", "error", 500);
    host.getState().showToast("长信息", "info", 8000);
    vi.advanceTimersByTime(500);
    expect(texts(host)).toEqual(["长信息"]);
    vi.advanceTimersByTime(7499);
    expect(texts(host)).toEqual(["长信息"]);
    vi.advanceTimersByTime(1);
    expect(texts(host)).toEqual([]);
  });
});

describe("提示切片：队列", () => {
  it("不同的提示并存，按发出先后排列，编号互不相同", () => {
    const host = createHost();
    host.getState().showToast("甲");
    host.getState().showToast("乙", "error");
    expect(host.getState().toasts.map((item) => [item.text, item.type])).toEqual([
      ["甲", "info"],
      ["乙", "error"],
    ]);
    expect(new Set(host.getState().toasts.map((item) => item.id)).size).toBe(2);
  });

  it("每条各自计时，到点的先消失", () => {
    const host = createHost();
    host.getState().showToast("先发的");
    vi.advanceTimersByTime(1000);
    host.getState().showToast("后发的");
    vi.advanceTimersByTime(2000);
    expect(texts(host)).toEqual(["后发的"]);
    vi.advanceTimersByTime(1000);
    expect(texts(host)).toEqual([]);
  });

  it(`队列满 ${TOAST_LIMIT} 条时，最早的一条让位，它的计时一并作废`, () => {
    const host = createHost();
    host.getState().showToast("一");
    host.getState().showToast("二");
    host.getState().showToast("三");
    expect(texts(host)).toEqual(["一", "二", "三"]);
    host.getState().showToast("四", "error");
    expect(texts(host)).toEqual(["二", "三", "四"]);
    expect(vi.getTimerCount()).toBe(TOAST_LIMIT);
  });

  it("dismissToast 立即摘掉指定的一条，它的计时作废", () => {
    const host = createHost();
    host.getState().showToast("甲");
    host.getState().showToast("乙");
    host.getState().dismissToast(host.getState().toasts[0].id);
    expect(texts(host)).toEqual(["乙"]);
    expect(vi.getTimerCount()).toBe(1);
  });

  it("clearToasts 清空全部提示并取消计时", () => {
    const host = createHost();
    host.getState().showToast("甲");
    host.getState().showToast("乙", "error");
    host.getState().clearToasts();
    expect(texts(host)).toEqual([]);
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe("提示切片：同一句话连发", () => {
  it("同文同类型重发：仍是一条、编号不变，重播次数加一", () => {
    const host = createHost();
    host.getState().showToast("轮到你了");
    const first = host.getState().toasts[0];
    host.getState().showToast("轮到你了");
    expect(host.getState().toasts).toHaveLength(1);
    expect(host.getState().toasts[0].id).toBe(first.id);
    expect(host.getState().toasts[0].repeat ?? 0).toBe((first.repeat ?? 0) + 1);
  });

  it("重发重新计时，按最后一次的时长消失", () => {
    const host = createHost();
    host.getState().showToast("同一句", "error");
    vi.advanceTimersByTime(4000);
    host.getState().showToast("同一句", "error");
    vi.advanceTimersByTime(4999);
    expect(texts(host)).toEqual(["同一句"]);
    vi.advanceTimersByTime(1);
    expect(texts(host)).toEqual([]);
  });

  it("重发不挪位置，也不挤掉别的提示", () => {
    const host = createHost();
    host.getState().showToast("甲");
    host.getState().showToast("乙");
    host.getState().showToast("丙");
    host.getState().showToast("甲");
    expect(texts(host)).toEqual(["甲", "乙", "丙"]);
  });

  it("同一句话换了类型就是另一条提示", () => {
    const host = createHost();
    host.getState().showToast("轮到你了", "info");
    host.getState().showToast("轮到你了", "error");
    expect(host.getState().toasts.map((item) => item.type)).toEqual(["info", "error"]);
  });

  it("消失之后再发同一句，是新的一条", () => {
    const host = createHost();
    host.getState().showToast("同一句");
    const first = host.getState().toasts[0].id;
    vi.advanceTimersByTime(3000);
    host.getState().showToast("同一句");
    expect(host.getState().toasts).toHaveLength(1);
    expect(host.getState().toasts[0].id).not.toBe(first);
  });

  it("列表被外部清空后（预置复位），同一句话照常成条并按时消失", () => {
    const host = createHost();
    host.getState().showToast("同一句");
    host.setState({ toasts: [] });
    host.getState().showToast("同一句");
    expect(texts(host)).toEqual(["同一句"]);
    vi.advanceTimersByTime(3000);
    expect(texts(host)).toEqual([]);
  });
});
