import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ServerMessage } from "@/types";
const sockets = vi.hoisted(() => {
  const make = () => ({ send: vi.fn(), connect: vi.fn(), disconnect: vi.fn(),
    messages: [] as Array<(message: ServerMessage) => void>, statuses: [] as Array<(connected: boolean) => void> });
  return { faker: make(), song: make() };
});
vi.mock("@/lib/WhoIsFakerWs", () => ({ send: sockets.faker.send, connect: sockets.faker.connect, whoIsFakerWsClient: { disconnect: sockets.faker.disconnect },
  onMessage: (fn: (m: ServerMessage) => void) => { sockets.faker.messages.push(fn); return () => { sockets.faker.messages = sockets.faker.messages.filter(h => h !== fn); }; },
  onStatus: (fn: (b: boolean) => void) => { sockets.faker.statuses.push(fn); return () => { sockets.faker.statuses = sockets.faker.statuses.filter(h => h !== fn); }; } }));
vi.mock("@/lib/SonGuessrWs", () => ({ sonGuessrWs: { send: sockets.song.send, connect: sockets.song.connect, disconnect: sockets.song.disconnect,
  onMessage: (fn: (m: ServerMessage) => void) => { sockets.song.messages.push(fn); return () => { sockets.song.messages = sockets.song.messages.filter(h => h !== fn); }; },
  onStatus: (fn: (b: boolean) => void) => { sockets.song.statuses.push(fn); return () => { sockets.song.statuses = sockets.song.statuses.filter(h => h !== fn); }; } } }));
import { useWhoIsFakerStore, initWhoIsFakerWs } from "./UseWhoIsFakerStore";
import { useSonGuessrStore, initSonGuessrWs } from "./UseSonGuessrStore";
import { getSessionToken, saveSessionToken, getSonGuessrSessionToken, saveSonGuessrSessionToken } from "@/lib/Storage";
import { wifSnapshot, wifPrivate, WIF_PEOPLE } from "@/stories/fixtures/WhoIsFaker";
import { songSnapshot, songPrivate } from "@/stories/fixtures/SonGuessr";
const deferred = <T,>() => { let resolve!: (v: T) => void; let reject!: (e: unknown) => void; const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };
const params = { roomId: "1234", name: "取消入房", visibility: "public" as const, allowSpectators: true, userName: "玩家" };
const fakerInitial = useWhoIsFakerStore.getState(), songInitial = useSonGuessrStore.getState();
const harnesses = [
  { name: "Faker", prefix: "", store: useWhoIsFakerStore, socket: sockets.faker, init: initWhoIsFakerWs,
    reset: () => useWhoIsFakerStore.setState(fakerInitial, true), read: getSessionToken, save: saveSessionToken,
    snapshot: { ...wifSnapshot("waiting"), roomId: "1234" }, privateState: wifPrivate(WIF_PEOPLE.host, "waiting"), snapshotEvent: "room.snapshot", privateEvent: "game.privateState" },
  { name: "Song", prefix: "song.", store: useSonGuessrStore, socket: sockets.song, init: initSonGuessrWs,
    reset: () => useSonGuessrStore.setState(songInitial, true), read: getSonGuessrSessionToken, save: saveSonGuessrSessionToken,
    snapshot: songSnapshot({ roomId: "1234" }), privateState: songPrivate(), snapshotEvent: "song.room.snapshot", privateEvent: "song.game.privateState" },
];
for (const h of harnesses) describe(`${h.name} 入房ACK所有权`, () => {
  let dispose: (() => void) | undefined;
  const receipt = (roomId = "1234", token = "late-token") => ({ roomId, sessionToken: token, snapshot: { ...h.snapshot, roomId }, privateState: { ...h.privateState, sessionToken: token } });
  beforeEach(() => { vi.useFakeTimers(); sessionStorage.clear(); h.reset(); h.socket.send.mockReset(); h.socket.messages = []; h.socket.statuses = []; });
  afterEach(() => { dispose?.(); dispose = undefined; h.reset(); vi.clearAllTimers(); vi.useRealTimers(); });
  it.each(["create", "join", "reconnect"] as const)("%s取消晚ACK只释放精确席位，不安装本地身份", async kind => {
    const ack = deferred<Record<string, unknown>>(); h.socket.send.mockReturnValueOnce(ack.promise).mockResolvedValue({});
    if (kind === "reconnect") h.save("1234", "previous-token");
    const owner = new AbortController();
    const task = kind === "create" ? h.store.getState().createRoom(params, owner.signal) : kind === "join" ? h.store.getState().joinRoom("1234", "玩家", undefined, owner.signal) : h.store.getState().reconnectRoom("1234", owner.signal);
    const outcome = task.catch(e => e); owner.abort(); ack.resolve(receipt());
    expect(await outcome).toMatchObject({ name: "AbortError" });
    expect(h.socket.send.mock.calls.map(([type]) => type)).toEqual([`${h.prefix}room.${kind}`, `${h.prefix}room.leave`]);
    expect(h.socket.send.mock.calls[1][2]).toEqual({ roomId: "1234", sessionToken: "late-token" });
    expect(h.read("1234")).toBeNull(); expect(h.store.getState()).toMatchObject({ roomId: null, sessionToken: null, snapshot: null, privateState: null });
  });
  it("新加入等待旧取消ACK及leave落定", async () => {
    const ack = deferred<Record<string, unknown>>(), leave = deferred<Record<string, unknown>>();
    h.socket.send.mockReturnValueOnce(ack.promise).mockReturnValueOnce(leave.promise).mockResolvedValue(receipt("5678", "new-token"));
    const owner = new AbortController(); const old = h.store.getState().joinRoom("1234", "旧玩家", undefined, owner.signal).catch(e => e);
    owner.abort(); const next = h.store.getState().joinRoom("5678", "新玩家"); expect(h.socket.send).toHaveBeenCalledTimes(1);
    ack.resolve(receipt()); await vi.advanceTimersByTimeAsync(0);
    expect(h.socket.send.mock.calls.map(([type]) => type)).toEqual([`${h.prefix}room.join`, `${h.prefix}room.leave`]);
    leave.resolve({}); expect(await old).toMatchObject({ name: "AbortError" }); await next;
    expect(h.socket.send.mock.calls.map(([type]) => type)).toEqual([`${h.prefix}room.join`, `${h.prefix}room.leave`, `${h.prefix}room.join`]);
    expect(h.read("5678")).toBe("new-token"); expect(h.store.getState()).toMatchObject({ roomId: "5678", sessionToken: "new-token", snapshot: { roomId: "5678" } });
  });
  it("StrictMode新owner接管同房恢复，旧调用取消不重复离房", async () => {
    h.save("1234", "previous-token"); const ack = deferred<Record<string, unknown>>(); h.socket.send.mockReturnValueOnce(ack.promise);
    const first = new AbortController(), second = new AbortController();
    const old = h.store.getState().reconnectRoom("1234", first.signal).catch(e => e); first.abort();
    const next = h.store.getState().reconnectRoom("1234", second.signal); expect(h.socket.send).toHaveBeenCalledTimes(1); ack.resolve(receipt());
    expect(await old).toMatchObject({ name: "AbortError" }); expect(await next).toBe(true); expect(h.socket.send).toHaveBeenCalledTimes(1); expect(h.read("1234")).toBe("late-token");
  });
  it("预先取消的三个入口不发命令", async () => {
    const owner = new AbortController(); owner.abort(); h.save("1234", "previous-token");
    await expect(h.store.getState().createRoom(params, owner.signal)).rejects.toMatchObject({ name: "AbortError" });
    await expect(h.store.getState().joinRoom("1234", "玩家", undefined, owner.signal)).rejects.toMatchObject({ name: "AbortError" });
    await expect(h.store.getState().reconnectRoom("1234", owner.signal)).rejects.toMatchObject({ name: "AbortError" });
    expect(h.socket.send).not.toHaveBeenCalled(); expect(h.read("1234")).toBe("previous-token");
  });
  it("取消恢复的晚永久拒绝不清token或发旧提示", async () => {
    h.save("1234", "previous-token"); const ack = deferred<Record<string, unknown>>(); h.socket.send.mockReturnValueOnce(ack.promise);
    const owner = new AbortController(), before = h.store.getState(); const task = h.store.getState().reconnectRoom("1234", owner.signal).catch(e => e);
    owner.abort(); ack.reject({ code: "SESSION_NOT_FOUND", message: "旧拒绝" }); expect(await task).toMatchObject({ name: "AbortError" });
    expect(h.read("1234")).toBe("previous-token"); expect(h.store.getState()).toBe(before);
  });
  it("断线后旧ACK不能安装身份或在新连接发旧leave", async () => {
    dispose = h.init(); const ack = deferred<Record<string, unknown>>(); h.socket.send.mockReturnValueOnce(ack.promise);
    const task = h.store.getState().joinRoom("1234", "玩家").catch(e => e); h.socket.statuses.forEach(fn => fn(false)); ack.resolve(receipt());
    expect(await task).toMatchObject({ name: "AbortError" }); expect(h.socket.send).toHaveBeenCalledTimes(1); expect(h.read("1234")).toBeNull(); expect(h.store.getState().roomId).toBeNull();
  });
  it("ACK前同步事件不建立身份，取消后临时状态回收", async () => {
    dispose = h.init(); const ack = deferred<Record<string, unknown>>(); h.socket.send.mockReturnValueOnce(ack.promise).mockResolvedValue({});
    const owner = new AbortController(); const task = h.store.getState().joinRoom("1234", "玩家", undefined, owner.signal).catch(e => e);
    for (const message of [
      { type: "event" as const, event: h.snapshotEvent, payload: { mode: "full", revision: 1, state: h.snapshot } },
      { type: "event" as const, event: h.privateEvent, payload: { mode: "full", revision: 1, state: { ...h.privateState, sessionToken: "late-token" } } },
    ]) h.socket.messages.forEach(fn => fn(message));
    expect(h.read("1234")).toBeNull(); expect(h.store.getState().roomId).toBeNull(); owner.abort(); ack.resolve(receipt());
    expect(await task).toMatchObject({ name: "AbortError" }); expect(h.store.getState()).toMatchObject({ roomId: null, sessionToken: null, snapshot: null, privateState: null });
  });
  it("自动恢复永久失效通知页面关闭，临时失败保留身份供再次恢复", async () => {
    dispose = h.init();
    h.save("1234", "previous-token");
    if (h.name === "Faker") useWhoIsFakerStore.setState({ roomId: "1234", sessionToken: "previous-token", snapshot: { ...wifSnapshot("waiting"), roomId: "1234" } });
    else useSonGuessrStore.setState({ roomId: "1234", sessionToken: "previous-token", snapshot: songSnapshot({ roomId: "1234" }) });
    h.socket.send.mockImplementation((type: string) => type === `${h.prefix}room.reconnect` ? Promise.reject({ code: "DISCONNECTED" }) : Promise.resolve({}));
    h.socket.statuses.forEach(fn => fn(true)); await vi.advanceTimersByTimeAsync(0);
    expect(h.store.getState()).toMatchObject({ roomId: "1234", sessionToken: "previous-token", roomClosedAt: null });
    expect(h.read("1234")).toBe("previous-token");
    h.socket.statuses.forEach(fn => fn(false));
    h.socket.send.mockImplementation((type: string) => type === `${h.prefix}room.reconnect` ? Promise.reject({ code: "PLAYER_KICKED" }) : Promise.resolve({}));
    h.socket.statuses.forEach(fn => fn(true)); await vi.advanceTimersByTimeAsync(0);
    expect(h.store.getState()).toMatchObject({ roomId: null, sessionToken: null, snapshot: null });
    expect(h.store.getState().roomClosedAt).toEqual(expect.any(Number));
    expect(h.read("1234")).toBeNull();
  });

  it("主动离开取消自动恢复，晚ACK释放席位而不重新入房", async () => {
    dispose = h.init(); h.save("1234", "previous-token");
    if (h.name === "Faker") useWhoIsFakerStore.setState({ roomId: "1234", sessionToken: "previous-token", snapshot: { ...wifSnapshot("waiting"), roomId: "1234" } });
    else useSonGuessrStore.setState({ roomId: "1234", sessionToken: "previous-token", snapshot: songSnapshot({ roomId: "1234" }) });
    const ack = deferred<Record<string, unknown>>();
    h.socket.send.mockImplementation((type: string) => type === `${h.prefix}room.reconnect` ? ack.promise : Promise.resolve({}));
    h.socket.statuses.forEach(fn => fn(true));
    await h.store.getState().leaveRoom(); ack.resolve(receipt()); await vi.advanceTimersByTimeAsync(0);
    expect(h.store.getState()).toMatchObject({ roomId: null, sessionToken: null, snapshot: null }); expect(h.read("1234")).toBeNull();
    expect(h.socket.send.mock.calls.filter(([type, , metadata]) => type === `${h.prefix}room.leave` && metadata.sessionToken === "late-token")).toHaveLength(1);
  });

  it("已有A身份进入B的preACK状态暂存，取消后A展示与命令身份一致", async () => {
    dispose = h.init(); h.save("1234", "old-A");
    if (h.name === "Faker") useWhoIsFakerStore.setState({ roomId: "1234", sessionToken: "old-A", snapshot: { ...wifSnapshot("waiting"), roomId: "1234" }, privateState: wifPrivate(WIF_PEOPLE.host, "waiting") });
    else useSonGuessrStore.setState({ roomId: "1234", sessionToken: "old-A", snapshot: songSnapshot({ roomId: "1234" }), privateState: songPrivate() });
    const before = h.store.getState(); const ack = deferred<Record<string, unknown>>(); const owner = new AbortController();
    h.socket.send.mockImplementation((type: string) => type === `${h.prefix}room.join` ? ack.promise : Promise.resolve({}));
    const outcome = h.store.getState().joinRoom("5678", "玩家", undefined, owner.signal).catch(error => error);
    for (const event of [
      { type: "event" as const, event: h.snapshotEvent, payload: { mode: "full", revision: 1, state: { ...h.snapshot, roomId: "5678" } } },
      { type: "event" as const, event: h.privateEvent, payload: { mode: "full", revision: 1, state: { ...h.privateState, sessionToken: "new-B" } } },
    ]) h.socket.messages.forEach(fn => fn(event));
    expect(h.store.getState()).toMatchObject({ roomId: "1234", sessionToken: "old-A", snapshot: before.snapshot, privateState: before.privateState });
    owner.abort(); ack.resolve(receipt("5678", "new-B")); expect(await outcome).toMatchObject({ name: "AbortError" });
    expect(h.store.getState()).toMatchObject({ roomId: "1234", sessionToken: "old-A", snapshot: before.snapshot, privateState: before.privateState });
    expect(h.read("1234")).toBe("old-A"); expect(h.read("5678")).toBeNull();
  });
  it("真正异步preACK事件在无状态ACK后一次提交，身份提交前不展示", async () => {
    dispose = h.init(); const ack = deferred<Record<string, unknown>>(); h.socket.send.mockReturnValueOnce(ack.promise);
    const entered = h.store.getState().joinRoom("1234", "玩家");
    await Promise.resolve();
    for (const event of [
      { type: "event" as const, event: h.snapshotEvent, payload: { mode: "full", revision: 1, state: h.snapshot } },
      { type: "event" as const, event: h.privateEvent, payload: { mode: "full", revision: 1, state: { ...h.privateState, sessionToken: "late-token" } } },
    ]) h.socket.messages.forEach(fn => fn(event));
    expect(h.store.getState()).toMatchObject({ roomId: null, sessionToken: null, snapshot: null, privateState: null });
    ack.resolve({ roomId: "1234", sessionToken: "late-token" }); await entered;
    expect(h.store.getState()).toMatchObject({ roomId: "1234", sessionToken: "late-token", snapshot: { roomId: "1234" }, privateState: { playerId: h.privateState.playerId } });
  });

});
