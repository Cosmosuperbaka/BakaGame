import { describe, expect, test } from "bun:test";

import type { GameServices } from "../src/application/GameRegistry";
import { AppError } from "../src/domain/Errors";
import { GAME_IDS } from "../src/shared/Protocol";
import { createGameEndpoints, GAME_PROTOCOLS } from "../src/transport/GameEndpoints";

const services = { faker: {}, song: {}, cee: {} } as unknown as GameServices;

describe("端点表", () => {
  test("协议表覆盖每一款游戏，键与自带的 game 字段一致", () => {
    expect(Object.keys(GAME_PROTOCOLS).sort()).toEqual([...GAME_IDS].sort());
    for (const game of GAME_IDS) expect(GAME_PROTOCOLS[game].game).toBe(game);
  });

  test("日志前缀沿用旧值", () => {
    expect(GAME_IDS.map((game) => GAME_PROTOCOLS[game].serviceName)).toEqual([
      "WhoIsFaker",
      "SonGuessr",
      "CEE",
    ]);
  });

  test("端点把各自的服务原样接上，协议部分不变", () => {
    const endpoints = createGameEndpoints(services);
    for (const game of GAME_IDS) {
      expect(endpoints[game].service).toBe(services[game]);
      expect(endpoints[game].parse).toBe(GAME_PROTOCOLS[game].parse);
      expect(endpoints[game].serviceName).toBe(GAME_PROTOCOLS[game].serviceName);
    }
  });

  test("前缀只被对应的一款认领，卧底不认领任何类型", () => {
    expect(GAME_PROTOCOLS.song.ownsType("song.room.join")).toBe(true);
    expect(GAME_PROTOCOLS.song.ownsType("cee.room.join")).toBe(false);
    expect(GAME_PROTOCOLS.cee.ownsType("cee.game.guess")).toBe(true);
    expect(GAME_PROTOCOLS.cee.ownsType("room.join")).toBe(false);
    expect(GAME_PROTOCOLS.faker.ownsType("room.join")).toBe(false);
    expect(GAME_PROTOCOLS.faker.ownsType("song.room.join")).toBe(false);
  });

  test("每款只解析自己的命令表：别款的命令被当作未知类型拒绝", () => {
    expect(() => GAME_PROTOCOLS.song.parse({ id: "1", type: "room.join", payload: {} })).toThrow(
      AppError
    );
    expect(() =>
      GAME_PROTOCOLS.faker.parse({ id: "1", type: "song.room.join", payload: {} })
    ).toThrow(AppError);
  });
});
