import { describe, expect, it } from "vitest";
import type { DescriptionRecord, PublicPlayerView, WhoIsFakerRoomSnapshot } from "@bakagame/shared";
import { wifSnapshot, WIF_PEOPLE } from "@/stories/fixtures/WhoIsFaker";
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

  // 三种发言模式各至少两组快照：对勾格的列键与已提交名单都取自服务端下发的状态。
  const withStatus = (
    snapshot: WhoIsFakerRoomSnapshot,
    patch: Partial<WhoIsFakerRoomSnapshot["status"]>
  ) => ({ ...snapshot, status: { ...snapshot.status, ...patch } });
  const submittedCases: {
    name: string;
    snapshot: WhoIsFakerRoomSnapshot;
    key: string;
    submitted: string[];
  }[] = [
    {
      name: "描述首轮全员已交",
      snapshot: wifSnapshot("day1"),
      key: "cycle-1",
      submitted: [
        WIF_PEOPLE.peach.id,
        WIF_PEOPLE.azumi.id,
        WIF_PEOPLE.me.id,
        WIF_PEOPLE.kanade.id,
        WIF_PEOPLE.kita.id,
        WIF_PEOPLE.long.id,
        WIF_PEOPLE.yuzu.id,
        WIF_PEOPLE.stone.id,
      ],
    },
    {
      name: "描述次轮进行中",
      snapshot: wifSnapshot("day2"),
      key: "cycle-2",
      submitted: [
        WIF_PEOPLE.kanade.id,
        WIF_PEOPLE.peach.id,
        WIF_PEOPLE.long.id,
        WIF_PEOPLE.yuzu.id,
      ],
    },
    {
      name: "补充发言进行中",
      snapshot: wifSnapshot("sup2"),
      key: "sup-1",
      submitted: [WIF_PEOPLE.kita.id],
    },
    {
      name: "第二次补充发言",
      snapshot: withStatus(wifSnapshot("sup2"), {
        supplementIndex: 2,
        speechOrder: [WIF_PEOPLE.me.id, WIF_PEOPLE.kita.id],
        submittedSpeechPlayerIds: [WIF_PEOPLE.me.id],
      }),
      key: "sup-2",
      submitted: [WIF_PEOPLE.me.id],
    },
    {
      name: "平票发言进行中",
      snapshot: wifSnapshot("tie2"),
      key: "tie-1",
      submitted: [WIF_PEOPLE.peach.id],
    },
    {
      name: "第二次平票发言",
      snapshot: withStatus(wifSnapshot("tie2"), {
        tieBreakIndex: 2,
        speechOrder: [WIF_PEOPLE.kita.id, WIF_PEOPLE.peach.id],
        submittedSpeechPlayerIds: [],
      }),
      key: "tie-2",
      submitted: [],
    },
  ];

  it.each(submittedCases)("$name：列键与已提交名单", ({ snapshot, key, submitted }) => {
    const history = buildSpeechHistory(snapshot.descriptions, snapshot.players, snapshot.status);
    expect(history.submittedColumnKey).toBe(key);
    expect([...history.submittedPlayerIds!]).toEqual(submitted);
  });
});
