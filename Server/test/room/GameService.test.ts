import { describe, expect, test } from "bun:test";

import type { GameService } from "../../src/application/GameService";
import type { CEEService } from "../../src/application/CEEService";
import type { SonGuessrService } from "../../src/application/SonGuessrService";
import type { WhoIsFakerService } from "../../src/application/WhoIsFakerService";
import type { CEEClientMessage } from "../../src/shared/CEE";
import type { SonGuessrClientMessage } from "../../src/shared/SonGuessr";
import type { WhoIsFakerClientMessage } from "../../src/shared/WhoIsFaker";

/** 编译期断言：三款门面今天已经结构上满足公共形状，接入注册表时只需加 `implements`。 */
type Satisfies<TService extends GameService<TMessage>, TMessage> = TService;

export type FakerFits = Satisfies<WhoIsFakerService, WhoIsFakerClientMessage>;
export type SongFits = Satisfies<SonGuessrService, SonGuessrClientMessage>;
export type CEEFits = Satisfies<CEEService, CEEClientMessage>;

describe("游戏服务公共形状", () => {
  test("形状只有类型、不带运行时实现", async () => {
    const module = await import("../../src/application/GameService");
    expect(Object.keys(module)).toEqual([]);
  });
});
