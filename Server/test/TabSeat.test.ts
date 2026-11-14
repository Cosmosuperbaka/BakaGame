import { describe, expect, test } from "bun:test";
import { CEEOriginalService } from "../src/application/CEEOriginalService";
import { SonGuessrService } from "../src/application/SonGuessrService";
import { tabSeatId } from "../src/application/TabSeat";
import { WhoIsFakerService } from "../src/application/WhoIsFakerService";
import type { ConnectionRecord } from "../src/shared/Index";
import type { CEERoomEnterResult, CEERoomSnapshot } from "../src/shared/CEE";
import type { SonGuessrRoomSnapshot } from "../src/shared/SonGuessr";
import type { WhoIsFakerRoomSnapshot } from "../src/shared/WhoIsFaker";
import { ceeTestHarness, type CEETestClient } from "./CEENativeFixtures";
import { FixtureRoom, originalData } from "./CEEOriginalFixtures";
import { createConnection, createTestContext, execute, getLastEventPayload } from "./Helpers";
import { connection as songConnection, lastEvent, provider } from "./songuessr/Fixtures";
import { createTestConnection } from "./support/Connection";

const TAB_A = "a".repeat(64);
const TAB_B = "b".repeat(64);

const tabConnection = (service: WhoIsFakerService, id: string, tabKey = TAB_A) => {
  const client = createConnection(service, id);
  client.record.tabKey = tabKey;
  return client;
};

const fakerJoin = (
  service: WhoIsFakerService,
  client: ReturnType<typeof createConnection>,
  userName: string,
  roomId = "1234"
) =>
  execute(service, client, {
    id: crypto.randomUUID(),
    type: "room.join",
    roomId,
    payload: { userName },
  }) as Promise<{ playerId: string; sessionToken: string }>;

const fakerCreate = (
  service: WhoIsFakerService,
  client: ReturnType<typeof createConnection>,
  roomId = "1234",
  extra: { visibility?: "public" | "private"; password?: string } = {}
) =>
  execute(service, client, {
    id: crypto.randomUUID(),
    type: "room.create",
    payload: {
      roomId,
      name: "房间",
      visibility: extra.visibility ?? "public",
      allowSpectators: true,
      userName: "房主",
      ...(extra.password ? { password: extra.password } : {}),
    },
  }) as Promise<{ playerId: string; sessionToken: string }>;

describe("派生玩家号", () => {
  test("同一标签页同一房间恒定，换房或换游戏就是另一个号", () => {
    const connection = { tabKey: TAB_A };
    const seat = tabSeatId(connection, "faker", "1234");
    expect(seat).toBe(tabSeatId(connection, "faker", "1234"));
    expect(seat).not.toBe(tabSeatId(connection, "faker", "1235"));
    expect(seat).not.toBe(tabSeatId(connection, "song", "1234"));
    expect(seat).not.toBe(tabSeatId({ tabKey: TAB_B }, "faker", "1234"));
  });

  test("公开的玩家号不含身份键，且落在协议长度内", () => {
    const seat = tabSeatId({ tabKey: TAB_A }, "faker", "1234")!;
    expect(seat).toMatch(/^tab_[0-9a-f]{32}$/);
    expect(seat).not.toContain(TAB_A);
    expect(seat.length).toBeLessThanOrEqual(64);
  });

  test("没有标签页身份的连接不派生，由各服务按原方式发号", () => {
    expect(tabSeatId({}, "faker", "1234")).toBeUndefined();
  });
});

describe("卧底：标签页身份即玩家", () => {
  test("退出房间再进：玩家号不变，自己的历史消息仍归自己", async () => {
    const { service } = createTestContext();
    const host = tabConnection(service, "host", TAB_B);
    await fakerCreate(service, host);
    const guest = tabConnection(service, "guest");
    const first = await fakerJoin(service, guest, "访客");
    await execute(service, guest, {
      id: "chat",
      type: "chat.send",
      payload: { text: "退房前说的话" },
    });
    await execute(service, guest, { id: "leave", type: "room.leave", payload: {} });

    const again = await fakerJoin(service, guest, "访客");

    expect(again.playerId).toBe(first.playerId);
    expect(guest.record.playerId).toBe(first.playerId);
    const snapshot = getLastEventPayload<WhoIsFakerRoomSnapshot>(guest, "room.snapshot");
    const mine = snapshot?.chat.find((message) => message.text === "退房前说的话");
    expect(mine?.playerId).toBe(first.playerId);
  });

  test("没有标签页身份的旧客户端：行为不变，重进仍是新玩家号", async () => {
    const { service } = createTestContext();
    await fakerCreate(service, tabConnection(service, "host", TAB_B));
    const legacy = createConnection(service, "legacy");
    const first = await fakerJoin(service, legacy, "旧客户端");
    expect(first.playerId).toMatch(/^player_/);
    await execute(service, legacy, { id: "leave", type: "room.leave", payload: {} });

    const again = await fakerJoin(service, legacy, "旧客户端");
    expect(again.playerId).not.toBe(first.playerId);
  });

  test("同账号的两张标签页各占一席，互不覆盖", async () => {
    const { service } = createTestContext();
    await fakerCreate(service, tabConnection(service, "host", TAB_B));
    const account = { userId: "user-1", image: null };
    const left = tabConnection(service, "left", "c".repeat(64));
    const right = tabConnection(service, "right", "d".repeat(64));
    left.record.account = account;
    right.record.account = account;

    const seatLeft = await fakerJoin(service, left, "左边");
    const seatRight = await fakerJoin(service, right, "右边");

    expect(seatLeft.playerId).not.toBe(seatRight.playerId);
    expect(left.record.playerId).toBe(seatLeft.playerId);
    expect(right.record.playerId).toBe(seatRight.playerId);
  });

  test("座位还在时再次加入等于回到原座位：不撞名、不要口令、不多占一席", async () => {
    const { service } = createTestContext();
    const host = tabConnection(service, "host", TAB_B);
    await fakerCreate(service, host, "1234", { visibility: "private", password: "secret" });
    const guest = tabConnection(service, "guest");
    const seat = (await execute(service, guest, {
      id: "join",
      type: "room.join",
      roomId: "1234",
      payload: { userName: "访客", password: "secret" },
    })) as { playerId: string; sessionToken: string };
    await service.unregisterConnection(guest.record.id);

    const refreshed = tabConnection(service, "guest-2");
    const resumed = await fakerJoin(service, refreshed, "访客");

    expect(resumed).toMatchObject({ playerId: seat.playerId, sessionToken: seat.sessionToken });
    const snapshot = getLastEventPayload<WhoIsFakerRoomSnapshot>(refreshed, "room.snapshot");
    expect(snapshot?.players.filter((player) => player.name === "访客")).toHaveLength(1);
    expect(snapshot?.players.find((player) => player.id === seat.playerId)?.online).toBe(true);
  });

  test("座位凭证丢了也能凭标签页身份接回原座位", async () => {
    const { service } = createTestContext();
    await fakerCreate(service, tabConnection(service, "host", TAB_B));
    const guest = tabConnection(service, "guest");
    const seat = await fakerJoin(service, guest, "访客");
    await service.unregisterConnection(guest.record.id);

    const refreshed = tabConnection(service, "guest-2");
    const resumed = (await execute(service, refreshed, {
      id: "reconnect",
      type: "room.reconnect",
      payload: { roomId: "1234", sessionToken: "stale-token" },
    })) as { playerId: string };
    expect(resumed.playerId).toBe(seat.playerId);
  });

  test("别的标签页拿不到这个座位：错凭证照样被拒", async () => {
    const { service } = createTestContext();
    await fakerCreate(service, tabConnection(service, "host", TAB_B));
    await fakerJoin(service, tabConnection(service, "guest"), "访客");

    const stranger = tabConnection(service, "stranger", "e".repeat(64));
    await expect(
      execute(service, stranger, {
        id: "reconnect",
        type: "room.reconnect",
        payload: { roomId: "1234", sessionToken: "guessed" },
      })
    ).rejects.toMatchObject({ code: "SESSION_NOT_FOUND" });
  });

  test("被踢后重连仍回 PLAYER_KICKED，不能凭标签页身份回到席位", async () => {
    const { service } = createTestContext();
    const host = tabConnection(service, "host", TAB_B);
    await fakerCreate(service, host);
    const guest = tabConnection(service, "guest");
    const seat = await fakerJoin(service, guest, "访客");
    await execute(service, host, {
      id: "kick",
      type: "room.kick",
      payload: { playerId: seat.playerId },
    });

    const refreshed = tabConnection(service, "guest-2");
    await expect(
      execute(service, refreshed, {
        id: "reconnect",
        type: "room.reconnect",
        payload: { roomId: "1234", sessionToken: "stale-token" },
      })
    ).rejects.toMatchObject({ code: "PLAYER_KICKED" });
  });

  test("对局中退房再进：沿用玩家号但只是旁观，不复活回合里的席位", async () => {
    const { service } = createTestContext();
    const host = tabConnection(service, "host", TAB_B);
    await fakerCreate(service, host, "Oblivionis");
    const guest = tabConnection(service, "guest");
    const seat = await fakerJoin(service, guest, "访客", "Oblivionis");
    await execute(service, host, { id: "bots", type: "test.addBot", payload: { count: 6 } });
    await execute(service, host, {
      id: "jump",
      type: "test.jumpToPhase",
      payload: { phase: "wordSubmission" },
    });
    await execute(service, host, {
      id: "words",
      type: "game.submitWords",
      payload: { words: ["苹果", "香蕉"] },
    });
    // 这名玩家恰好是卧底时离场就直接结算了：换成平民，才测得到「局还在继续」的分支。
    const room = (
      service as unknown as {
        rooms: Map<
          string,
          { round: { assignments: Record<string, { alive: boolean; side: string }> } }
        >;
      }
    ).rooms.get("Oblivionis")!;
    const assignments = room.round.assignments;
    const civilian = Object.entries(assignments).find(([, item]) => item.side === "good")?.[1];
    const mine = assignments[seat.playerId];
    if (civilian && mine && mine.side !== "good") {
      const swapped = { ...mine };
      Object.assign(mine, civilian);
      Object.assign(civilian, swapped);
    }
    await execute(service, guest, { id: "leave", type: "room.leave", payload: {} });

    const again = await fakerJoin(service, guest, "访客", "Oblivionis");

    expect(again.playerId).toBe(seat.playerId);
    const snapshot = getLastEventPayload<WhoIsFakerRoomSnapshot>(guest, "room.snapshot");
    expect(snapshot?.status.phase).not.toBe("gameOver");
    expect(snapshot?.players.find((player) => player.id === seat.playerId)).toMatchObject({
      membership: "spectator",
      roundStatus: "spectator",
    });
    expect(assignments[seat.playerId]?.alive).toBe(false);
  });

  test("重启恢复：带派生号的快照不会把发号计数器撑爆", async () => {
    const { service } = createTestContext();
    const host = tabConnection(service, "host", TAB_B);
    const seat = await fakerCreate(service, host);
    const exported = service.exportSnapshots();

    const restored = createTestContext().service;
    expect(restored.restoreSnapshots(exported, Date.now())).toBe(1);

    const legacy = createConnection(restored, "legacy");
    await fakerCreate(restored, legacy, "4321");
    expect(legacy.record.playerId).toMatch(/^player_[0-9a-z]{1,8}$/);

    const refreshed = tabConnection(restored, "refreshed", TAB_B);
    const resumed = (await execute(restored, refreshed, {
      id: "reconnect",
      type: "room.reconnect",
      payload: { roomId: "1234", sessionToken: seat.sessionToken },
    })) as { playerId: string };
    expect(resumed.playerId).toBe(seat.playerId);
  });
});

describe("猜歌：标签页身份即玩家", () => {
  const start = async () => {
    const service = new SonGuessrService({ musicProvider: provider, random: { nextInt: () => 0 } });
    const client = (id: string, tabKey: string) => {
      const created = songConnection(service, id);
      created.record.tabKey = tabKey;
      return created;
    };
    const host = client("host", TAB_B);
    await service.execute(host.record.id, {
      id: "create",
      type: "song.room.create",
      payload: {
        roomId: "1234",
        name: "房间",
        visibility: "public",
        allowSpectators: true,
        userName: "房主",
      },
    });
    return { service, host, client };
  };

  test("退出房间再进：玩家号不变，自己的历史消息仍归自己", async () => {
    const { service, client } = await start();
    const guest = client("guest", TAB_A);
    const join = () =>
      service.execute(guest.record.id, {
        id: crypto.randomUUID(),
        type: "song.room.join",
        roomId: "1234",
        payload: { userName: "访客" },
      }) as Promise<{ playerId: string }>;
    const first = await join();
    await service.execute(guest.record.id, {
      id: "chat",
      type: "song.chat.send",
      roomId: "1234",
      payload: { text: "退房前说的话" },
    });
    await service.execute(guest.record.id, {
      id: "leave",
      type: "song.room.leave",
      roomId: "1234",
      payload: {},
    });

    const again = await join();

    expect(again.playerId).toBe(first.playerId);
    const snapshot = lastEvent<SonGuessrRoomSnapshot>(guest, "song.room.snapshot");
    expect(snapshot.chat.find((message) => message.text === "退房前说的话")?.playerId).toBe(
      first.playerId
    );
  });

  test("座位还在时再次加入回到原座位，不撞名也不多占一席", async () => {
    const { service, client } = await start();
    const guest = client("guest", TAB_A);
    const join = (target: typeof guest) =>
      service.execute(target.record.id, {
        id: crypto.randomUUID(),
        type: "song.room.join",
        roomId: "1234",
        payload: { userName: "访客" },
      }) as Promise<{ playerId: string; sessionToken: string }>;
    const seat = await join(guest);
    await service.unregisterConnection(guest.record.id);

    const refreshed = client("guest-2", TAB_A);
    const resumed = await join(refreshed);

    expect(resumed).toMatchObject({ playerId: seat.playerId, sessionToken: seat.sessionToken });
    const snapshot = lastEvent<SonGuessrRoomSnapshot>(refreshed, "song.room.snapshot");
    expect(snapshot.players.filter((player) => player.name === "访客")).toHaveLength(1);
  });
});

describe("CEE 增强房：标签页身份即玩家", () => {
  const withTab = (harness: ReturnType<typeof ceeTestHarness>, name: string, tabKey: string) => {
    const client = harness.connect(name);
    client.record.tabKey = tabKey;
    return client;
  };

  test("退出房间再进：玩家号不变，自己的历史消息仍归自己", async () => {
    const harness = ceeTestHarness();
    const host = withTab(harness, "房主", TAB_B);
    await harness.send(host, "cee.room.create", {
      source: "native",
      roomId: "1234",
      name: "房间",
      userName: "房主",
      visibility: "public",
      allowSpectators: true,
    });
    const guest = withTab(harness, "访客", TAB_A);
    await harness.send(guest, "cee.room.join", { userName: "访客" });
    const firstId = guest.id;
    await harness.send(guest, "cee.chat.send", { text: "退房前说的话" });
    await harness.send(guest, "cee.room.leave", {});

    await harness.send(guest, "cee.room.join", { userName: "访客" });

    expect(guest.id).toBe(firstId);
    const snapshot = harness.snapshot(guest);
    expect(snapshot.chat.find((message) => message.text === "退房前说的话")?.playerId).toBe(
      firstId
    );
  });

  test("座位还在时再次加入回到原座位，不撞名也不多占一席", async () => {
    const harness = ceeTestHarness();
    const host = withTab(harness, "房主", TAB_B);
    await harness.send(host, "cee.room.create", {
      source: "native",
      roomId: "1234",
      name: "房间",
      userName: "房主",
      visibility: "public",
      allowSpectators: true,
    });
    const guest = withTab(harness, "访客", TAB_A);
    await harness.send(guest, "cee.room.join", { userName: "访客" });
    const seatId = guest.id;
    await harness.service.unregisterConnection(guest.record.id);

    const refreshed = withTab(harness, "访客二", TAB_A);
    await harness.send(refreshed, "cee.room.join", { userName: "访客" });

    expect(refreshed.id).toBe(seatId);
    const snapshot: CEERoomSnapshot = harness.snapshot(refreshed);
    expect(snapshot.players.filter((player) => player.name === "访客")).toHaveLength(1);
  });

  test("对局中退房再进只是观战：全队走光后不会等一个不能行动的人", async () => {
    const harness = ceeTestHarness();
    const host = withTab(harness, "房主", TAB_B);
    await harness.send(host, "cee.room.create", {
      source: "native",
      roomId: "1234",
      name: "房间",
      userName: "房主",
      visibility: "public",
      allowSpectators: true,
    });
    const left: CEETestClient = withTab(harness, "左", TAB_A);
    await harness.send(left, "cee.room.join", { userName: "左" });
    const right: CEETestClient = withTab(harness, "右", "c".repeat(64));
    await harness.send(right, "cee.room.join", { userName: "右" });
    await harness.send(host, "cee.player.team", { team: 1 });
    await harness.send(left, "cee.player.team", { team: 2 });
    await harness.send(right, "cee.player.team", { team: 2 });
    await harness.configure(host, {});
    await harness.ready(left, right);
    await harness.send(host, "cee.game.start", {});
    expect(harness.snapshot(host).phase).toBe("guessing");

    await harness.send(left, "cee.room.leave", {});
    await harness.send(left, "cee.room.join", { userName: "左" });
    expect(harness.snapshot(left).players.find((player) => player.id === left.id)?.status).toBe(
      "observing"
    );

    // 猜题的一队只剩右：他也走了，全队已无人能行动，这一队按投降收束。
    await harness.send(host, "cee.game.surrender", {});
    await harness.send(right, "cee.room.leave", {});
    expect(harness.snapshot(host).phase).toBe("settled");
  });
});

describe("CEE 原版房：上游换号后聊天仍归同一标签页", () => {
  test("退房再进换了上游 socket，本地聊天的归属跟着走", async () => {
    const upstream = new FixtureRoom();
    const service = new CEEOriginalService({
      data: originalData,
      serverUrl: "https://original.example",
      aesSecret: "fixture-key",
      socketFactory: upstream.factory,
      fetcher: async () => Response.json([{ id: "1234", isPublic: true, playerCount: 2 }]),
    });
    const target = { source: "original" as const, roomId: "1234", upstreamRoomId: "1234" };
    const connection = (id: string): ConnectionRecord =>
      createTestConnection(id, { tabKey: TAB_A });
    const keeper: ConnectionRecord = { ...connection("keeper"), tabKey: TAB_B };
    service.registerConnection(keeper);
    await service.join("keeper", target, { userName: "留守" });

    const guest = connection("guest");
    service.registerConnection(guest);
    const first = await service.join("guest", target, { userName: "访客" });
    await service.execute("guest", {
      id: "chat",
      type: "cee.chat.send",
      roomId: "1234",
      sessionToken: first.sessionToken,
      payload: { text: "退房前说的话" },
    });
    await service.execute("guest", {
      id: "leave",
      type: "cee.room.leave",
      roomId: "1234",
      sessionToken: first.sessionToken,
      payload: {},
    });

    const again: CEERoomEnterResult = await service.join("guest", target, { userName: "访客" });

    const mine = again.snapshot.chat.find((message) => message.text === "退房前说的话");
    expect(mine?.playerId).toBe(again.privateState.playerId);
    service.close();
  });
});
