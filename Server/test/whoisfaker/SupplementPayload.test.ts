import { describe, expect, test } from "bun:test";
import { Value } from "@sinclair/typebox/value";

import { WhoIsFakerPayloadSchemas } from "../../src/shared/WhoIsFaker";

// 房间不设人数上限，补充发言名单因此没有固定的条数上限：它的大小靠「逐个校验为局内存活玩家」
// 加「不收重复项」界定，合法名单不会比局内人数长。
describe("补充发言名单的契约", () => {
  const schema = WhoIsFakerPayloadSchemas["game.requestSupplement"];
  const players = (count: number) => Array.from({ length: count }, (_, index) => `p${index}`);

  test("重复点名同一名玩家被契约层拒绝", () => {
    expect(Value.Check(schema, { playerIds: ["p1", "p2"] })).toBe(true);
    expect(Value.Check(schema, { playerIds: ["p1", "p1"] })).toBe(false);
    expect(Value.Check(schema, { playerIds: [...players(40), "p7"] })).toBe(false);
  });

  test("互不相同的名单不设固定条数上限，空名单照旧被拒", () => {
    expect(Value.Check(schema, { playerIds: players(200) })).toBe(true);
    expect(Value.Check(schema, { playerIds: [] })).toBe(false);
  });
});
