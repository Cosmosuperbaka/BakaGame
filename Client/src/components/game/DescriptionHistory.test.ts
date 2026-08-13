import { describe, expect, it } from "vitest";

import type { DescriptionRecord, PublicPlayerView } from "@/types";

import { collectDescriptionRows } from "./DescriptionHistory";

const player = (id: string, isHost = false): PublicPlayerView => ({
  id,
  name: id,
  score: 0,
  membership: "active",
  online: true,
  isReady: false,
  isBot: false,
  isHost,
  roundStatus: "alive",
});

describe("description history rows", () => {
  it("keeps the exact player-list order even when the host is not first", () => {
    const players = [player("first"), player("host", true), player("third")];

    expect(collectDescriptionRows(players, []).map(({ id }) => id)).toEqual([
      "first",
      "host",
      "third",
    ]);
  });

  it("appends departed speakers without reordering current players", () => {
    const record: DescriptionRecord = {
      id: "description-1",
      playerId: "departed",
      playerName: "已离场",
      text: "描述",
      kind: "description",
      cycle: 1,
      createdAt: 1,
    };

    expect(collectDescriptionRows([player("second"), player("first", true)], [record])
      .map(({ id }) => id)).toEqual(["second", "first", "departed"]);
  });
});
