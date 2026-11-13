import { describe, expect, it } from "vitest";
import type { DescriptionRecord, PublicPlayerView } from "@bakagame/shared";
import { buildSpeechHistory } from "./FakerSpeechHistory";

const player = (id: string, name: string): PublicPlayerView => ({
  id,
  name,
  score: 0,
  membership: "active",
  online: true,
  isReady: true,
  isBot: false,
  isHost: false,
  roundStatus: "alive",
});
const speech = (playerId: string, playerName: string, cycle: number): DescriptionRecord => ({
  id: `${playerId}-${cycle}`,
  playerId,
  playerName,
  text: "发言",
  kind: "description",
  cycle,
  createdAt: 1,
});

describe("buildSpeechHistory", () => {
  it("名册里已无此人的发言作者合成离线占位，同一人只合成一次", () => {
    const history = buildSpeechHistory(
      [speech("gone", "走了的人", 1), speech("gone", "走了的人", 2), speech("a", "甲", 1)],
      [player("a", "甲")],
      undefined
    );
    expect(history.departedPlayers).toHaveLength(1);
    expect(history.departedPlayers[0]).toMatchObject({
      id: "gone",
      name: "走了的人",
      online: false,
    });
    expect(history.columns.map((column) => column.key)).toEqual(["cycle-1", "cycle-2"]);
  });

  it("进行中的列给出列键与已提交名单，供对勾格使用", () => {
    const history = buildSpeechHistory([], [player("a", "甲"), player("b", "乙")], {
      phase: "description",
      started: true,
      day: 2,
      speechOrder: ["a", "b"],
      submittedSpeechPlayerIds: ["b"],
    });
    expect(history.submittedColumnKey).toBe("cycle-2");
    expect([...history.submittedPlayerIds!]).toEqual(["b"]);
    expect(history.playerOrder?.get("a")?.get("cycle-2")).toBe(1);
  });

  it("没有状态时没有进行中的列", () => {
    const history = buildSpeechHistory([], [], undefined);
    expect(history.submittedColumnKey).toBeUndefined();
    expect(history.columns).toEqual([]);
  });
});
