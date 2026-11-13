import { afterEach, describe, expect, test } from "bun:test";
import { createDefaultCEESettings } from "../src/shared/CEE";
import { ceeTestHarness, type CEETestClient } from "./CEENativeFixtures";

const active: ReturnType<typeof ceeTestHarness>[] = [];
const keep = (h: ReturnType<typeof ceeTestHarness>) => {
  active.push(h);
  return h;
};
afterEach(() => {
  active.splice(0).forEach((test) => test.service.close());
});

/** 房主与一名访客；`guessing` 为真时访客已准备且已开局进入猜题阶段，否则停在等待阶段且访客未准备。 */
const room = async (guessing: boolean) => {
  const h = keep(ceeTestHarness());
  const host = await h.create();
  await h.configure(host, {});
  const guest = await h.join("访客");
  if (guessing) {
    await h.ready(guest);
    await h.send(host, "cee.game.start", {});
    expect(h.snapshot(host).phase).toBe("guessing");
  }
  return { h, host, guest };
};

type Rejection = { code: string; message: string };
const WAITING_ONLY: Rejection = { code: "INVALID_PHASE", message: "请在等待阶段修改" };

/**
 * 同时需要房主与特定阶段的命令。守卫顺序：先房主、后阶段，
 * 所以「非房主且阶段不对」的请求拿到房主错误，「房主但阶段不对」的请求拿到阶段错误。
 */
const HOST_THEN_PHASE: Array<[string, (guestId: string) => unknown, Rejection]> = [
  ["cee.room.settings", () => ({ settings: createDefaultCEESettings(2026) }), WAITING_ONLY],
  [
    "cee.room.update",
    () => ({ name: "新名字", visibility: "public", allowSpectators: true }),
    WAITING_ONLY,
  ],
  ["cee.directory.import", () => ({ indexId: 7 }), WAITING_ONLY],
  ["cee.game.start", () => ({}), { code: "INVALID_PHASE", message: "当前阶段无法开始游戏" }],
  [
    "cee.game.chooseSetter",
    (guestId) => ({ playerId: guestId }),
    { code: "INVALID_PHASE", message: "请先开始游戏再指定出题人" },
  ],
  ["cee.game.cancel", () => ({}), { code: "INVALID_PHASE", message: "当前没有等待中的出题任务" }],
  ["cee.game.next", () => ({}), { code: "INVALID_PHASE", message: "请等待本局结束" }],
];

describe("增强房命令守卫的先后顺序", () => {
  for (const [type, payload, phaseError] of HOST_THEN_PHASE) {
    test(`${type}：非房主且阶段不对报房主错误，房主且阶段不对报阶段错误`, async () => {
      const { h, host, guest } = await room(true);
      const send = (client: CEETestClient) =>
        h.send(client, type as "cee.room.settings", payload(guest.id!) as never);
      await expect(send(guest)).rejects.toMatchObject({
        code: "FORBIDDEN",
        message: "只有房主可以执行该操作",
      });
      await expect(send(host)).rejects.toMatchObject(phaseError);
    });
  }

  test("开局：阶段错误先于「人数与准备」判定，房主错误先于二者", async () => {
    const waiting = await room(false);
    // 访客未准备：阶段合法时房主拿到人数与准备错误，非房主仍先拿到房主错误。
    await expect(waiting.h.send(waiting.host, "cee.game.start", {})).rejects.toMatchObject({
      code: "PLAYERS_NOT_READY",
    });
    await expect(waiting.h.send(waiting.guest, "cee.game.start", {})).rejects.toMatchObject({
      code: "FORBIDDEN",
    });
  });

  test("等待阶段才能改的个人设置：阶段不对即拒", async () => {
    const { h, guest } = await room(true);
    await expect(h.send(guest, "cee.player.ready", { ready: false })).rejects.toMatchObject(
      WAITING_ONLY
    );
    await expect(h.send(guest, "cee.player.team", { team: 1 })).rejects.toMatchObject(WAITING_ONLY);
  });

  test("旁观切换：阶段先于「房间是否允许观战」", async () => {
    const { h, host, guest } = await room(false);
    await h.send(host, "cee.room.update", {
      name: "禁止观战",
      visibility: "public",
      allowSpectators: false,
    });
    // 阶段合法时才轮到「是否允许观战」。
    await expect(h.send(guest, "cee.player.spectate", { spectator: true })).rejects.toMatchObject({
      code: "SPECTATING_DISABLED",
    });
    await h.ready(guest);
    await h.send(host, "cee.game.start", {});
    await expect(h.send(guest, "cee.player.spectate", { spectator: true })).rejects.toMatchObject(
      WAITING_ONLY
    );
  });

  test("房主操作：房主错误先于操作自身的参数校验", async () => {
    const { h, host, guest } = await room(false);
    await expect(h.send(guest, "cee.room.kick", { playerId: guest.id! })).rejects.toMatchObject({
      code: "FORBIDDEN",
    });
    await expect(h.send(host, "cee.room.kick", { playerId: host.id! })).rejects.toMatchObject({
      code: "INVALID_PLAYER",
    });
    await expect(
      h.send(guest, "cee.room.transferHost", { playerId: "nobody" })
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(
      h.send(host, "cee.room.transferHost", { playerId: "nobody" })
    ).rejects.toMatchObject({ code: "PLAYER_NOT_FOUND" });
    await expect(
      h.send(guest, "cee.player.approveSpectate", { playerId: guest.id!, approved: true })
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(
      h.send(host, "cee.player.approveSpectate", { playerId: guest.id!, approved: true })
    ).rejects.toMatchObject({ code: "SPECTATE_NOT_PENDING" });
  });

  test("提交答案：不在出题阶段或不是出题人，同一个错误", async () => {
    const { h, host, guest } = await room(true);
    for (const client of [host, guest])
      await expect(
        h.send(client, "cee.game.setAnswer", { characterId: 1, hints: [] })
      ).rejects.toMatchObject({ code: "NOT_SETTER", message: "仅当前出题人可以提交答案" });
  });

  test("身份校验先于所有守卫：房号不符与令牌错误都拿到各自的错误码", async () => {
    const { h, guest } = await room(true);
    await expect(
      h.send(guest, "cee.room.settings", { settings: createDefaultCEESettings(2026) }, "9999")
    ).rejects.toMatchObject({ code: "ROOM_MISMATCH" });
    const forged: CEETestClient = { ...guest, token: "forged" };
    await expect(
      h.send(forged, "cee.room.settings", { settings: createDefaultCEESettings(2026) })
    ).rejects.toMatchObject({ code: "SESSION_INVALID" });
  });

  test("被守卫拒绝的命令照常发布一次房间状态，身份校验失败的不发布", async () => {
    const { h, host, guest } = await room(true);
    const before = host.sent.length;
    await expect(
      h.send(guest, "cee.room.settings", { settings: createDefaultCEESettings(2026) })
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect(host.sent.length).toBeGreaterThan(before);
    const afterRejected = host.sent.length;
    const forged: CEETestClient = { ...guest, token: "forged" };
    await expect(
      h.send(forged, "cee.room.settings", { settings: createDefaultCEESettings(2026) })
    ).rejects.toMatchObject({ code: "SESSION_INVALID" });
    expect(host.sent.length).toBe(afterRejected);
  });
});
