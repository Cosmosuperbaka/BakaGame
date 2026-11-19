import { describe, expect, test } from "bun:test";

import { createTestContext, execute } from "../Helpers";
import { createTestConnection } from "../support/Connection";
import { createRoom, joinPlayers } from "./Fixtures";

type Packet = { event?: string; payload?: unknown };

describe("房间快照发布", () => {
  test("同一次发布里公共快照帧只封一次，各人的私有态各自构造，且每人先收公共帧再收私有帧", async () => {
    const { service } = createTestContext();
    const { host } = await createRoom(service, "3001");
    const [guest] = await joinPlayers(service, "3001", 1, "客人");
    host.sent.length = 0;
    guest.connection.sent.length = 0;

    await execute(service, guest.connection, {
      id: "ready",
      type: "player.setReady",
      roomId: "3001",
      payload: { ready: true },
    });

    const events = (sent: unknown[]) => (sent as Packet[]).map((item) => item.event);
    expect(events(host.sent).slice(0, 2)).toEqual(["room.snapshot", "game.privateState"]);
    expect(events(guest.connection.sent).slice(0, 2)).toEqual([
      "room.snapshot",
      "game.privateState",
    ]);
    const snapshotOf = (sent: unknown[]) =>
      (sent as Packet[]).find((item) => item.event === "room.snapshot");
    const privateOf = (sent: unknown[]) =>
      (sent as Packet[]).find((item) => item.event === "game.privateState");
    expect(snapshotOf(host.sent)).toBeDefined();
    expect(snapshotOf(host.sent)).toBe(snapshotOf(guest.connection.sent));
    expect(privateOf(host.sent)).not.toBe(privateOf(guest.connection.sent));
  });

  test("校准帧走校准通道、口径与正常发布一致：同样先公共帧后私有帧，不走普通发送", async () => {
    const { service, advanceTime } = createTestContext();
    const sent: Packet[] = [];
    const calibrated: Packet[] = [];
    const record = createTestConnection("calibrated", {
      send: (payload) => {
        sent.push(payload as Packet);
      },
      sendStateSyncCalibration: (payload) => {
        calibrated.push(payload as Packet);
      },
    });
    service.registerConnection(record);
    await service.execute(record.id, {
      id: "create",
      type: "room.create",
      payload: {
        roomId: "3002",
        name: "校准",
        visibility: "public",
        allowSpectators: true,
        userName: "房主",
      },
    });
    sent.length = 0;

    advanceTime(1);
    await service.runHousekeeping();

    expect(sent).toEqual([]);
    expect(calibrated.map((item) => item.event)).toEqual(["room.snapshot", "game.privateState"]);
  });

  test("只给指定连接发布时，同房其他连接收不到", async () => {
    const { service } = createTestContext();
    const { host } = await createRoom(service, "3003");
    const [guest] = await joinPlayers(service, "3003", 1, "客人");
    host.sent.length = 0;
    guest.connection.sent.length = 0;

    // 同标签页接管等场景只重发给回座的那条连接；这里直接走重连入口验证单连接发布。
    await execute(service, guest.connection, {
      id: "sync",
      type: "room.requestSync",
      payload: {},
    });

    expect(host.sent).toEqual([]);
    expect((guest.connection.sent as Packet[]).some((item) => item.event === "room.snapshot")).toBe(
      true
    );
  });
});
