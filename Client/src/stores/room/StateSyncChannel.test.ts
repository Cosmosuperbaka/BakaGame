import { describe, expect, it, vi } from "vitest";
import { createStateSyncChannel } from "./StateSyncChannel";

type Snapshot = { roomId: string; name: string };
type Private = { playerId: string };

const snapshot: Snapshot = { roomId: "1234", name: "测试" };
const privateState: Private = { playerId: "p1" };

const full = <T>(state: T, revision: number) => ({ mode: "full" as const, revision, state });
const patch = (baseRevision: number, revision: number, name: string) => ({
  mode: "patch" as const,
  baseRevision,
  revision,
  operations: [{ op: "replace" as const, path: "/name", value: name }],
});
const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

const setup = (defer: () => boolean = () => false) => {
  const requestFull = vi.fn<() => Promise<unknown>>(() => Promise.resolve({}));
  const onError = vi.fn();
  const channel = createStateSyncChannel<Snapshot, Private>({ requestFull, defer, onError });
  return { channel, requestFull, onError };
};

describe("StateSyncChannel", () => {
  it("全量安装基线后连续补丁逐条应用，两条通道的修订号各自独立", () => {
    const { channel, requestFull } = setup();
    expect(channel.snapshot.consume(full(snapshot, 1))).toEqual(snapshot);
    expect(channel.snapshot.baseline()).toEqual(snapshot);
    expect(channel.snapshot.consume(patch(1, 2, "第二幕"))).toEqual({
      ...snapshot,
      name: "第二幕",
    });
    expect(channel.snapshot.consume(patch(2, 3, "第三幕"))).toEqual({
      ...snapshot,
      name: "第三幕",
    });

    expect(channel.privateState.consume(full(privateState, 1))).toEqual(privateState);
    expect(
      channel.privateState.consume({
        mode: "patch",
        baseRevision: 1,
        revision: 2,
        operations: [{ op: "replace", path: "/playerId", value: "p2" }],
      })
    ).toEqual({ playerId: "p2" });
    expect(requestFull).not.toHaveBeenCalled();
  });

  it("跳号或非法载荷返回 null 并发起全量，基线保持旧值", async () => {
    const { channel, requestFull } = setup();
    channel.snapshot.consume(full(snapshot, 1));
    expect(channel.snapshot.consume(patch(2, 3, "错位"))).toBeNull();
    expect(requestFull).toHaveBeenCalledTimes(1);
    expect(channel.snapshot.baseline()).toEqual(snapshot);

    await flush();
    expect(channel.snapshot.consume({ name: "无版本号的裸状态" })).toBeNull();
    expect(requestFull).toHaveBeenCalledTimes(2);
    expect(channel.snapshot.baseline()).toEqual(snapshot);
  });

  it("全量在途时，两条通道的后续缺口共用一个在途标记", async () => {
    let resolveRequest!: (value: unknown) => void;
    const { channel, requestFull } = setup();
    requestFull.mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveRequest = resolve;
        })
    );
    channel.snapshot.consume(full(snapshot, 1));
    expect(channel.snapshot.consume(patch(2, 3, "错位"))).toBeNull();
    // 私有态还没有基线，补丁同样构成缺口。
    expect(channel.privateState.consume(patch(0, 1, "错位"))).toBeNull();
    expect(channel.snapshot.consume(patch(2, 4, "再错位"))).toBeNull();
    expect(requestFull).toHaveBeenCalledTimes(1);

    resolveRequest({});
    await flush();
    expect(channel.snapshot.consume(patch(2, 5, "又错位"))).toBeNull();
    expect(requestFull).toHaveBeenCalledTimes(2);
  });

  it("全量请求失败走 onError，并释放在途标记供下一次缺口重发", async () => {
    const { channel, requestFull, onError } = setup();
    const error = { code: "TIMEOUT", message: "超时" };
    requestFull.mockRejectedValueOnce(error);
    channel.snapshot.consume(full(snapshot, 1));
    expect(channel.snapshot.consume(patch(2, 3, "错位"))).toBeNull();
    await flush();
    expect(onError).toHaveBeenCalledWith(error);

    expect(channel.snapshot.consume(patch(2, 4, "再错位"))).toBeNull();
    expect(requestFull).toHaveBeenCalledTimes(2);
  });

  it("暂缓口径为 true 时只记欠账，flushDeferred 仍走同一口径", () => {
    let entering = true;
    const { channel, requestFull } = setup(() => entering);
    expect(channel.snapshot.consume(patch(0, 1, "错位"))).toBeNull();
    expect(requestFull).not.toHaveBeenCalled();
    expect(channel.takeDeferred()).toBe(true);
    expect(channel.takeDeferred()).toBe(false);

    // 凭据未就绪时补发仍被压下，欠账重新登记。
    channel.flushDeferred();
    expect(requestFull).not.toHaveBeenCalled();
    expect(channel.takeDeferred()).toBe(true);

    entering = false;
    channel.flushDeferred();
    expect(requestFull).toHaveBeenCalledTimes(1);
    expect(channel.takeDeferred()).toBe(false);
  });

  it("在途优先于欠账：请求悬着时缺口不登记欠账", () => {
    let entering = false;
    const { channel, requestFull } = setup(() => entering);
    requestFull.mockImplementation(() => new Promise<never>(() => {}));
    channel.snapshot.consume(patch(0, 1, "错位"));
    expect(requestFull).toHaveBeenCalledTimes(1);

    entering = true;
    expect(channel.snapshot.consume(patch(0, 2, "再错位"))).toBeNull();
    expect(requestFull).toHaveBeenCalledTimes(1);
    expect(channel.takeDeferred()).toBe(false);
  });

  it("adopt 安装首屏状态并作废修订号，旧版本号的补丁改走全量", () => {
    const { channel, requestFull } = setup();
    channel.snapshot.consume(full(snapshot, 1));
    const ackSnapshot = { ...snapshot, name: "首屏" };
    channel.snapshot.adopt(ackSnapshot);
    expect(channel.snapshot.baseline()).toEqual(ackSnapshot);
    expect(channel.snapshot.consume(patch(1, 2, "错位"))).toBeNull();
    expect(requestFull).toHaveBeenCalledTimes(1);

    channel.privateState.adopt(null);
    expect(channel.privateState.baseline()).toBeNull();
  });

  it("reset 清空基线、修订号、在途与欠账，悬着的旧请求不压住新缺口", () => {
    let entering = true;
    const { channel, requestFull } = setup(() => entering);
    requestFull.mockImplementation(() => new Promise<never>(() => {}));
    channel.snapshot.consume(full(snapshot, 1));
    expect(channel.snapshot.consume(patch(2, 3, "错位"))).toBeNull();
    expect(channel.takeDeferred()).toBe(true);

    channel.reset();
    expect(channel.snapshot.baseline()).toBeNull();
    expect(channel.privateState.baseline()).toBeNull();
    expect(channel.takeDeferred()).toBe(false);

    // 重置后即使旧请求仍悬着，新基线的缺口也能立即再发。
    entering = false;
    channel.snapshot.consume(full(snapshot, 1));
    expect(channel.snapshot.consume(patch(2, 3, "错位"))).toBeNull();
    expect(requestFull).toHaveBeenCalledTimes(1);
  });

  it("clearRevisions 只作废修订号，基线保留", () => {
    const { channel, requestFull } = setup();
    channel.snapshot.consume(full(snapshot, 1));
    channel.privateState.consume(full(privateState, 1));
    channel.clearRevisions();
    expect(channel.snapshot.baseline()).toEqual(snapshot);
    expect(channel.privateState.baseline()).toEqual(privateState);
    expect(channel.snapshot.consume(patch(1, 2, "错位"))).toBeNull();
    expect(requestFull).toHaveBeenCalledTimes(1);
    expect(channel.snapshot.consume(full({ ...snapshot, name: "恢复" }, 2))).toEqual({
      ...snapshot,
      name: "恢复",
    });
  });

  it("clearRevisions 对私有态通道同样生效", () => {
    const { channel, requestFull } = setup();
    channel.privateState.consume(full(privateState, 1));
    channel.clearRevisions();
    expect(
      channel.privateState.consume({
        mode: "patch",
        baseRevision: 1,
        revision: 2,
        operations: [{ op: "replace", path: "/playerId", value: "p2" }],
      })
    ).toBeNull();
    expect(requestFull).toHaveBeenCalledTimes(1);
    expect(channel.privateState.baseline()).toEqual(privateState);
  });

  it("reset 连没取走的欠账与私有态基线一起清掉", () => {
    const { channel } = setup(() => true);
    channel.privateState.consume(full(privateState, 1));
    expect(channel.snapshot.consume(patch(0, 1, "错位"))).toBeNull();

    channel.reset();
    expect(channel.privateState.baseline()).toBeNull();
    expect(channel.takeDeferred()).toBe(false);
  });
});
