import { describe, expect, test } from "bun:test";

import { eachGame, type GameServices } from "../src/application/GameRegistry";
import { GAME_IDS } from "../src/shared/Protocol";

const stubServices = () => {
  const calls: string[] = [];
  const stub = (name: string) => ({
    name,
    publishTabRooms: (tabKey: string) => calls.push(`${name}:${tabKey}`),
  });
  const services = {
    faker: stub("faker"),
    song: stub("song"),
    cee: stub("cee"),
  } as unknown as GameServices;
  return { services, calls };
};

describe("eachGame", () => {
  test("按 GAME_IDS 的顺序对每一款恰好访问一次，并把对应的服务交给访问函数", () => {
    const { services } = stubServices();
    const visited = eachGame(services, (game, service) => [
      game,
      (service as unknown as { name: string }).name,
    ]);
    expect(visited.map(([game]) => game)).toEqual([...GAME_IDS]);
    for (const [game, name] of visited) expect(name).toBe(game);
  });

  test("收集每次访问的返回值，供求和这类归约使用", () => {
    const { services } = stubServices();
    expect(eachGame(services, (game) => game.length)).toEqual(GAME_IDS.map((game) => game.length));
  });

  test("访问函数对公共形状的调用落到各自的服务上", () => {
    const { services, calls } = stubServices();
    eachGame(services, (_, service) => service.publishTabRooms("tab-1"));
    expect(calls).toEqual(GAME_IDS.map((game) => `${game}:tab-1`));
  });

  test("访问函数同步抛错时中断后面的款，和逐款手写等价", () => {
    const { services, calls } = stubServices();
    expect(() =>
      eachGame(services, (game, service) => {
        service.publishTabRooms("tab-2");
        if (game === "song") throw new Error("准入被拒");
      })
    ).toThrow("准入被拒");
    expect(calls).toEqual(["faker:tab-2", "song:tab-2"]);
  });
});
