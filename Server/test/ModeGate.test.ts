import { describe, expect, test } from "bun:test";
import { GAME_PROTOCOLS } from "../src/transport/GameEndpoints";
import { assertModeOpen } from "../src/transport/ModeGate";
import { OPEN_SITE_FEATURES, type SiteFeatures } from "../src/shared/SiteFeatures";

const closed = (overrides: Partial<SiteFeatures>) => () => ({
  ...OPEN_SITE_FEATURES,
  ...overrides,
});

describe("createMode", () => {
  test("三款游戏的建房命令各自对应一个模式", () => {
    expect(GAME_PROTOCOLS.faker.createMode({ type: "room.create" })).toBe("fakerEntry");
    expect(
      GAME_PROTOCOLS.song.createMode({ type: "song.room.create", payload: { solo: true } })
    ).toBe("songSoloEntry");
    expect(GAME_PROTOCOLS.song.createMode({ type: "song.room.create", payload: {} })).toBe(
      "songMultiplayerEntry"
    );
    // 原版房也算多人模式：同一个大厅里的入口不该一个关了另一个还能开。
    expect(
      GAME_PROTOCOLS.cee.createMode({ type: "cee.room.create", payload: { source: "original" } })
    ).toBe("ceeMultiplayerEntry");
  });

  test("加入、重连和局内命令都不算建房", () => {
    expect(GAME_PROTOCOLS.faker.createMode({ type: "room.join" })).toBeUndefined();
    expect(GAME_PROTOCOLS.song.createMode({ type: "song.room.join" })).toBeUndefined();
    expect(GAME_PROTOCOLS.song.createMode({ type: "song.game.start" })).toBeUndefined();
    expect(GAME_PROTOCOLS.cee.createMode({ type: "cee.room.reconnect" })).toBeUndefined();
    // 排位只停首页入口，不在服务端拦。
    expect(GAME_PROTOCOLS.cee.createMode({ type: "cee.ranked.queue" })).toBeUndefined();
  });
});

describe("assertModeOpen", () => {
  test("模式关闭时拒绝新开房间，并说明是暂时关闭", () => {
    expect(() =>
      assertModeOpen(GAME_PROTOCOLS.faker, { type: "room.create" }, closed({ fakerEntry: false }))
    ).toThrow("谁是卧底暂时关闭，请稍后再来");
    try {
      assertModeOpen(
        GAME_PROTOCOLS.song,
        { type: "song.room.create", payload: { solo: true } },
        closed({ songSoloEntry: false })
      );
      throw new Error("应当被拒绝");
    } catch (error) {
      expect((error as { code?: string }).code).toBe("MODE_CLOSED");
    }
  });

  test("只关单人时多人照常建房，已有房间照常加入", () => {
    const features = closed({ songSoloEntry: false, fakerEntry: false });
    expect(() =>
      assertModeOpen(GAME_PROTOCOLS.song, { type: "song.room.create", payload: {} }, features)
    ).not.toThrow();
    expect(() =>
      assertModeOpen(GAME_PROTOCOLS.faker, { type: "room.join" }, features)
    ).not.toThrow();
  });

  test("没有装配开关时全部放行", () => {
    expect(() =>
      assertModeOpen(GAME_PROTOCOLS.cee, { type: "cee.room.create" }, undefined)
    ).not.toThrow();
  });

  test("每次都现读开关，后台改完下一条建房命令就生效", () => {
    let open = true;
    const features = () => ({ ...OPEN_SITE_FEATURES, ceeMultiplayerEntry: open });
    expect(() =>
      assertModeOpen(GAME_PROTOCOLS.cee, { type: "cee.room.create" }, features)
    ).not.toThrow();
    open = false;
    expect(() => assertModeOpen(GAME_PROTOCOLS.cee, { type: "cee.room.create" }, features)).toThrow(
      "猜动漫角色多人模式暂时关闭"
    );
  });
});
