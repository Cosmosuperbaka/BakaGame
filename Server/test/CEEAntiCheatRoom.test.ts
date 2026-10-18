import { describe, expect, test } from "bun:test";
import {
  CEE_SPECTATE_APPROVAL_TIMEOUT_MS,
  CEE_SPECTATE_QUEUE_MAX,
} from "../src/application/CEERooms";
import { createDefaultCEESettings, parseCEESettings } from "../src/shared/CEE";
import { ceeTestHarness, type CEETestClient, type CEETestIdentity } from "./CEENativeFixtures";
import type { ClientChannelProof, PlayerAccount } from "../src/shared/Index";

const account = (id: string): PlayerAccount => ({ userId: id, image: null });
const channel = (clientType: ClientChannelProof["clientType"] = "desktop"): ClientChannelProof => ({
  clientId: `client-${clientType}-1`,
  clientType,
  clientVersion: "1.0.0",
  keyProtection: "hardware",
});
/** 反作弊房里的合法成员：既是客户端接入，又已登录。 */
const trusted = (id: string): CEETestIdentity => ({
  account: account(id),
  clientChannel: channel(),
});

/** 房主自己先成为合法成员，否则「中途开启」会被他自己挡住。 */
async function antiCheatRoom() {
  const h = ceeTestHarness();
  const host = await h.create("房主", trusted("u-host"));
  await h.configure(host, { bakaAntiCheat: true });
  return { h, host };
}

describe("CEE 反作弊房准入", () => {
  test("开启开关后房间快照带出标记，供大厅卡片在进房前展示", async () => {
    const { h, host } = await antiCheatRoom();
    expect(h.snapshot(host).bakaAntiCheat).toBe(true);
    expect(h.snapshot(host).settings.bakaAntiCheat).toBe(true);
  });
  test("浏览器接入被拒：没有通道证明就进不了反作弊房", async () => {
    const { h } = await antiCheatRoom();
    const web = h.connect("浏览器");
    await expect(h.send(web, "cee.room.join", { userName: "浏览器" })).rejects.toMatchObject({
      code: "CLIENT_REQUIRED",
    });
  });
  test("有通道证明但未登录仍被拒：旁观者也要可追溯", async () => {
    const { h } = await antiCheatRoom();
    const guest = h.connect("游客客户端", { clientChannel: channel("mobile") });
    await expect(h.send(guest, "cee.room.join", { userName: "游客" })).rejects.toMatchObject({
      code: "LOGIN_REQUIRED",
    });
  });
  test("客户端且已登录可加入，移动端与桌面端同权", async () => {
    const { h } = await antiCheatRoom();
    const mate = await h.join("玩家二", {
      account: account("u-two"),
      clientChannel: channel("mobile"),
    });
    expect(h.snapshot(mate).players.map((p) => p.name)).toContain("玩家二");
  });
  test("断线重连走同一道准入：证明丢失后旧凭据也进不来", async () => {
    const { h, host } = await antiCheatRoom();
    const mate = await h.join("玩家二", trusted("u-two"));
    const web = h.connect("玩家二-浏览器重连");
    const refused = h.send(web, "cee.room.reconnect", {
      roomId: "1234",
      sessionToken: mate.token!,
    });
    await expect(refused).rejects.toMatchObject({ code: "CLIENT_REQUIRED" });
    const restored = h.connect("玩家二-客户端重连", trusted("u-two"));
    const entry = await h.send(restored, "cee.room.reconnect", {
      roomId: "1234",
      sessionToken: mate.token!,
    });
    expect((entry as { privateState: { playerId: string } }).privateState.playerId).toBe(mate.id!);
    expect(h.snapshot(host).spectateRequests).toEqual([]);
  });
  test("中途开启被 Web 接入挡住并说清原因，人退出后才能开", async () => {
    const h = ceeTestHarness();
    const host = await h.create("房主", trusted("u-host"));
    const web = await h.join("玩家二");
    await expect(h.configure(host, { bakaAntiCheat: true })).rejects.toMatchObject({
      code: "ANTI_CHEAT_BLOCKED",
      message: "请先让 Web 接入的玩家退出",
    });
    expect(h.snapshot(host).bakaAntiCheat).toBe(false);
    await h.send(web, "cee.room.leave", {});
    await h.configure(host, { bakaAntiCheat: true });
    expect(h.snapshot(host).bakaAntiCheat).toBe(true);
  });
  test("中途开启被未登录玩家挡住", async () => {
    const h = ceeTestHarness();
    const host = await h.create("房主", trusted("u-host"));
    const guest = await h.join("玩家二", { clientChannel: channel() });
    await expect(h.configure(host, { bakaAntiCheat: true })).rejects.toMatchObject({
      code: "ANTI_CHEAT_BLOCKED",
      message: "请先让未登录的玩家退出或登录",
    });
    await h.send(guest, "cee.room.leave", {});
    await h.configure(host, { bakaAntiCheat: true });
    expect(h.snapshot(host).settings.bakaAntiCheat).toBe(true);
  });
  test("普通房间完全不读通道证明：Web 未登录照常游玩与观战", async () => {
    const h = ceeTestHarness();
    const host = await h.create("房主");
    const mate = await h.join("玩家二");
    const result = (await h.send(mate, "cee.player.spectate", { spectator: true })) as {
      pending: boolean;
      membership: string;
    };
    expect(result).toEqual({ pending: false, membership: "spectator" });
    expect(h.snapshot(host).spectateRequests).toEqual([]);
    expect(h.privateState(mate).spectatePending).toBe(false);
  });
});

describe("CEE 反作弊房旁观审批", () => {
  test("反作弊房切旁观只登记请求，待批准期间不下发答案", async () => {
    const { h, host } = await antiCheatRoom();
    const mate = await h.join("玩家二", trusted("u-two"));
    const viewer = await h.join("观众三", trusted("u-view"));

    const result = (await h.send(viewer, "cee.player.spectate", { spectator: true })) as {
      pending: boolean;
      membership: string;
    };
    expect(result).toEqual({ pending: true, membership: "pendingSpectator" });
    expect(h.snapshot(host).spectateRequests).toEqual([
      { playerId: viewer.id as string, name: "观众三", requestedAt: h.now() },
    ]);
    const pending = h.privateState(viewer);
    expect(pending.spectatePending).toBe(true);
    expect(pending.answer).toBeNull();

    // 待批准不算参与态：既不挡开局，也不被当成玩家。
    await h.ready(mate);
    await h.send(host, "cee.game.start", {});
    expect(h.snapshot(host).spectateRequests).toHaveLength(1);
    expect(h.privateState(viewer).spectatePending).toBe(true);
  });
  test("开局后批准，旁观者拿到出题人视角", async () => {
    const { h, host } = await antiCheatRoom();
    const mate = await h.join("玩家二", trusted("u-two"));
    const viewer = await h.join("观众三", trusted("u-view"));
    await h.send(viewer, "cee.player.spectate", { spectator: true });
    await h.ready(mate);
    await h.send(host, "cee.game.start", {});

    await h.send(host, "cee.player.approveSpectate", {
      playerId: viewer.id as string,
      approved: true,
    });
    expect(h.snapshot(host).spectateRequests).toEqual([]);
    expect(h.privateState(viewer).spectatePending).toBe(false);
    expect(h.privateState(viewer).answer).not.toBeNull();
    expect(viewer.sent).toContainEqual({
      type: "event",
      event: "cee.player.spectateResult",
      payload: { approved: true },
    });
  });
  test("房主拒绝立即退回参与态，不等超时，且拒绝可归因", async () => {
    const { h, host } = await antiCheatRoom();
    const mate = await h.join("玩家二", trusted("u-two"));
    await h.send(mate, "cee.player.spectate", { spectator: true });

    await h.send(host, "cee.player.approveSpectate", {
      playerId: mate.id as string,
      approved: false,
    });
    expect(h.snapshot(mate).players.find((p) => p.id === mate.id)?.membership).toBe("active");
    expect(h.latest(mate, "cee.player.spectateResult")).toEqual({ approved: false });
  });
  test("超时 120 秒自动转为拒绝，房主挂机不会让请求悬空", async () => {
    const { h, host } = await antiCheatRoom();
    const mate = await h.join("玩家二", trusted("u-two"));
    await h.send(mate, "cee.player.spectate", { spectator: true });

    h.advance(CEE_SPECTATE_APPROVAL_TIMEOUT_MS - 1);
    expect(h.snapshot(host).spectateRequests).toHaveLength(1);
    h.advance(2);
    expect(h.snapshot(host).spectateRequests).toEqual([]);
    expect(h.snapshot(mate).players.find((p) => p.id === mate.id)?.membership).toBe("active");
  });
  test("待批准队列有上限，刷请求骚扰房主会被挡", async () => {
    const { h, host } = await antiCheatRoom();
    const clients: CEETestClient[] = [];
    for (let i = 0; i < CEE_SPECTATE_QUEUE_MAX; i++) {
      const client = await h.join(`观众${i}`, trusted(`u-watch-${i}`));
      await h.send(client, "cee.player.spectate", { spectator: true });
      clients.push(client);
    }
    expect(h.snapshot(host).spectateRequests).toHaveLength(CEE_SPECTATE_QUEUE_MAX);
    const extra = await h.join("观众X", trusted("u-watch-x"));
    await expect(h.send(extra, "cee.player.spectate", { spectator: true })).rejects.toMatchObject({
      code: "SPECTATE_QUEUE_FULL",
    });
  });
  test("重复批准同一请求可归因报错，不由房主误操作二次改身份", async () => {
    const { h, host } = await antiCheatRoom();
    const mate = await h.join("玩家二", trusted("u-two"));
    await h.send(mate, "cee.player.spectate", { spectator: true });
    await h.send(host, "cee.player.approveSpectate", {
      playerId: mate.id as string,
      approved: true,
    });
    await expect(
      h.send(host, "cee.player.approveSpectate", { playerId: mate.id as string, approved: true })
    ).rejects.toMatchObject({ code: "SPECTATE_NOT_PENDING" });
  });
  test("非反作弊房调用审批被拒：这套流程不该在普通房出现", async () => {
    const h = ceeTestHarness();
    const host = await h.create("房主");
    await expect(
      h.send(host, "cee.player.approveSpectate", { playerId: "x", approved: true })
    ).rejects.toMatchObject({ code: "SPECTATE_NOT_PENDING" });
  });
  test("关掉开关后悬空的待批准请求退回参与态", async () => {
    const { h, host } = await antiCheatRoom();
    const mate = await h.join("玩家二", trusted("u-two"));
    await h.send(mate, "cee.player.spectate", { spectator: true });
    expect(h.snapshot(host).spectateRequests).toHaveLength(1);

    await h.configure(host, { bakaAntiCheat: false });
    expect(h.snapshot(host).spectateRequests).toEqual([]);
    expect(h.snapshot(mate).players.find((p) => p.id === mate.id)?.membership).toBe("active");
  });
  test("待批准者主动取消旁观即撤回请求", async () => {
    const { h, host } = await antiCheatRoom();
    const mate = await h.join("玩家二", trusted("u-two"));
    await h.send(mate, "cee.player.spectate", { spectator: true });
    await h.send(mate, "cee.player.spectate", { spectator: false });
    expect(h.snapshot(host).spectateRequests).toEqual([]);
    expect(h.snapshot(mate).players.find((p) => p.id === mate.id)?.membership).toBe("active");
  });
});

describe("CEE 反作弊设置的文件兼容", () => {
  test("旧设置文件缺 bakaAntiCheat 时补关，不把老文件判为非法", () => {
    const { bakaAntiCheat: _omitted, ...legacy } = createDefaultCEESettings(2026);
    expect(parseCEESettings(legacy).bakaAntiCheat).toBe(false);
    expect(parseCEESettings({ ...legacy, bakaAntiCheat: true }).bakaAntiCheat).toBe(true);
  });
  test("旧文件同时缺出题方式时两项一起补齐", () => {
    const { bakaAntiCheat: _a, answerMode: _b, ...legacy } = createDefaultCEESettings(2026);
    const restored = parseCEESettings(legacy);
    expect(restored).toMatchObject({ bakaAntiCheat: false, answerMode: "random" });
  });
});
