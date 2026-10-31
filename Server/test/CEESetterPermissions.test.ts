import { expect, test } from "bun:test";
import { CEEOriginalService } from "../src/application/CEEOriginalService";
import type { CEERoomClientMessage, CEERoomEnterResult } from "../src/shared/CEE";
import { FixtureRoom, originalData } from "./CEEOriginalFixtures";

test("原版手动出题：出题方式只记在本服务端，开始后进入选人阶段，出题人不必准备，可取消退回", async () => {
  const upstream = new FixtureRoom();
  const service = new CEEOriginalService({
    data: originalData,
    serverUrl: "https://original.example",
    aesSecret: "fixture-key",
    socketFactory: upstream.factory,
    fetcher: async () => Response.json([{ id: "1234", isPublic: true }]),
  });
  for (const id of ["host", "guest"])
    service.registerConnection({ id, lobbySubscribed: false, send() {}, close() {} });
  const send = (id: string, token: string, message: CEERoomClientMessage) =>
    service.execute(id, { ...message, sessionToken: token });
  const target = { source: "original" as const, roomId: "1234", upstreamRoomId: "1234" };
  try {
    const host = await service.create("host", target, {
      source: "original",
      roomId: "1234",
      name: "出题权限",
      userName: "房主",
      visibility: "public",
      allowSpectators: true,
    });
    const guest = await service.join("guest", target, { userName: "出题人" });
    await send("guest", guest.sessionToken, {
      id: "unready",
      type: "cee.player.ready",
      payload: { ready: false },
    });
    const sync = (id = "host", token = host.sessionToken) =>
      send(id, token, {
        id: `sync-${crypto.randomUUID()}`,
        type: "cee.room.requestSync",
        payload: {},
      }) as Promise<CEERoomEnterResult>;
    const waiting = await sync();
    expect(waiting.privateState.canStart).toBe(false);
    expect(waiting.privateState.setterCandidateIds).toEqual([]);

    await send("host", host.sessionToken, {
      id: "manual",
      type: "cee.room.settings",
      payload: { settings: { ...waiting.snapshot.settings, answerMode: "manual" } },
    });
    // 上游回推的设置里没有出题方式，本地记录不能被冲掉；同房的另一位玩家也看得到。
    expect((await sync()).snapshot.settings.answerMode).toBe("manual");
    expect((await sync("guest", guest.sessionToken)).snapshot.settings.answerMode).toBe("manual");
    const upstreamSettings = upstream.sockets
      .flatMap((socket) => socket.sent)
      .filter((item) => item.event === "updateGameSettings");
    expect(upstreamSettings.length).toBeGreaterThan(0);
    expect(
      upstreamSettings.some(
        (item) => "answerMode" in (item.payload as { settings: object }).settings
      )
    ).toBe(false);

    const manual = await sync();
    expect(manual.privateState.canStart).toBe(true);
    await expect(
      send("host", host.sessionToken, {
        id: "early",
        type: "cee.game.chooseSetter",
        payload: { playerId: guest.privateState.playerId },
      })
    ).rejects.toMatchObject({ code: "INVALID_PHASE" });
    await send("host", host.sessionToken, { id: "start", type: "cee.game.start", payload: {} });
    const choosing = await sync();
    expect(choosing.snapshot.phase).toBe("choosingSetter");
    expect(choosing.privateState.setterCandidateIds).toContain(guest.privateState.playerId);
    expect((await sync("guest", guest.sessionToken)).privateState.setterCandidateIds).toEqual([]);
    await send("host", host.sessionToken, { id: "cancel", type: "cee.game.cancel", payload: {} });
    expect((await sync()).snapshot.phase).toBe("waiting");

    await send("host", host.sessionToken, { id: "restart", type: "cee.game.start", payload: {} });
    await send("host", host.sessionToken, {
      id: "choose",
      type: "cee.game.chooseSetter",
      payload: { playerId: guest.privateState.playerId },
    });
    const answering = await sync();
    expect(answering.snapshot.phase).toBe("answering");
    expect(answering.privateState.setterCandidateIds).toEqual([]);
    expect((await sync("guest", guest.sessionToken)).privateState.canSetAnswer).toBe(true);
  } finally {
    service.close();
  }
});
