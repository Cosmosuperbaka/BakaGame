import { describe, expect, test } from "bun:test";
import { Type as t } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";

import { createClientEnvelopeSchema, GameIdSchema } from "../src/shared/Model";
import { GAME_IDS } from "../src/shared/Protocol";

describe("信封里的玩法标识", () => {
  const envelope = createClientEnvelopeSchema("probe.ping", t.Object({}));
  const frame = (game: unknown) => ({ id: "1", type: "probe.ping", game, payload: {} });

  test("GAME_IDS 里的每一款都被接受，其余取值被拒绝", () => {
    for (const game of GAME_IDS) {
      expect(Value.Check(GameIdSchema, game)).toBe(true);
      expect(Value.Check(envelope, frame(game))).toBe(true);
    }
    for (const game of ["karaoke", "", 1, null]) {
      expect(Value.Check(GameIdSchema, game)).toBe(false);
      expect(Value.Check(envelope, frame(game))).toBe(false);
    }
  });

  test("game 字段可省略：旧路径与旧客户端不带它", () => {
    expect(Value.Check(envelope, { id: "1", type: "probe.ping", payload: {} })).toBe(true);
  });
});
