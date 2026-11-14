import { describe, expect, it } from "vitest";

import type { DescriptionRecord, PublicPlayerView, WhoIsFakerRoomSnapshot } from "@bakagame/shared";

import { wifSnapshot, WIF_PEOPLE } from "@/stories/fixtures/WhoIsFaker";
import {
  buildDescriptionColumns,
  descriptionCellShade,
  descriptionCellShadeForPlayer,
  pendingColumn,
  type SpeechStatus,
} from "./DescriptionColumns";

const description = (
  id: string,
  playerId: string,
  kind: DescriptionRecord["kind"],
  index = 1
): DescriptionRecord => ({
  id,
  playerId,
  playerName: playerId,
  text: id,
  kind,
  cycle: 1,
  tieBreakIndex: kind === "tieBreak" ? index : undefined,
  supplementIndex: kind === "supplement" ? index : undefined,
  createdAt: index,
});

describe("description column model", () => {
  it("keeps normal, tie-break and supplement numbering independent", () => {
    const records = [
      description("normal", "p1", "description"),
      description("tie-2", "p2", "tieBreak", 2),
      description("supplement-1", "p1", "supplement", 1),
    ];

    const model = buildDescriptionColumns(records);

    expect(model.columns.map(({ key, label }) => ({ key, label }))).toEqual([
      { key: "cycle-1", label: "第 1 轮" },
      { key: "tie-2", label: "平票 2" },
      { key: "sup-1", label: "补充 1" },
    ]);
    expect(model.byPlayer.get("p1")?.get("sup-1")?.id).toBe("supplement-1");
    // 列序在三类列全部展开后才连续编号，表格据此计算棋盘格底色。
    expect(model.columns.map(({ index }) => index)).toEqual([0, 1, 2]);
  });

  it("shades cells as a checkerboard so rows and columns both stay traceable", () => {
    expect(descriptionCellShade(0, 0)).toBe(descriptionCellShade(1, 1));
    expect(descriptionCellShade(0, 1)).toBe(descriptionCellShade(1, 0));
    expect(descriptionCellShade(0, 0)).not.toBe(descriptionCellShade(0, 1));
  });

  it("keeps spectator and questioner history cells on a plain background", () => {
    const player = (overrides: Partial<PublicPlayerView>): PublicPlayerView => ({
      id: "p1",
      name: "玩家",
      score: 0,
      membership: "active",
      online: true,
      isReady: false,
      isBot: false,
      isHost: false,
      roundStatus: "alive",
      ...overrides,
    });

    expect(descriptionCellShadeForPlayer(player({ membership: "spectator" }), 0, 0)).toBe("");
    expect(descriptionCellShadeForPlayer(player({ roundStatus: "questioner" }), 0, 0)).toBe("");
    expect(descriptionCellShadeForPlayer(player({}), 0, 0)).toBe(descriptionCellShade(0, 0));
  });

  it("keeps the full active speech order even when an early submission is still hidden", () => {
    const status: SpeechStatus = {
      phase: "description",
      started: true,
      day: 2,
      speechMode: "supplement",
      supplementIndex: 3,
      speechOrder: ["p1", "p2", "p3"],
      submittedSpeechPlayerIds: ["p1"],
      pendingSupplementPlayerIds: ["p2", "p3"],
    };

    const model = buildDescriptionColumns(
      [description("old-supplement", "p1", "supplement", 1)],
      status
    );

    expect(model.columns.map(({ key }) => key)).toEqual(["sup-1", "sup-3"]);
    expect(model.columns.find(({ key }) => key === "sup-1")?.expectedPlayerIds).toEqual(
      new Set(["p1"])
    );
    expect(model.columns.find(({ key }) => key === "sup-3")?.expectedPlayerIds).toEqual(
      new Set(["p1", "p2", "p3"])
    );
  });

  it("does not show pending tie-break speeches after voting has begun", () => {
    const status: SpeechStatus = {
      phase: "tieBreak",
      started: true,
      day: 1,
      speechMode: "tieBreak",
      tieBreakStage: "vote",
      tieBreakIndex: 1,
      tieBreakCandidateIds: ["p1", "p2"],
    };

    expect(buildDescriptionColumns([], status).columns).toEqual([]);
  });

  it("extracts and assigns speech order sequence across multiple rounds", () => {
    const records: DescriptionRecord[] = [
      {
        ...description("desc-1-p2", "p2", "description"),
        cycle: 1,
        order: 1,
      },
      {
        ...description("desc-1-p1", "p1", "description"),
        cycle: 1,
        order: 2,
      },
    ];

    const status: SpeechStatus = {
      phase: "description",
      started: true,
      day: 2,
      speechOrder: ["p1", "p2"],
    };

    const model = buildDescriptionColumns(records, status);

    // 第 1 轮：p2 为 1，p1 为 2
    expect(model.playerOrder.get("p2")?.get("cycle-1")).toBe(1);
    expect(model.playerOrder.get("p1")?.get("cycle-1")).toBe(2);

    // 第 2 轮（进行中）：根据 speechOrder，p1 为 1，p2 为 2
    expect(model.playerOrder.get("p1")?.get("cycle-2")).toBe(1);
    expect(model.playerOrder.get("p2")?.get("cycle-2")).toBe(2);
  });

  // 三种发言模式各至少两组快照：进行中的列键、应发言名单与顺位都取自服务端下发的顺序。
  const withStatus = (snapshot: WhoIsFakerRoomSnapshot, patch: Partial<SpeechStatus>) => ({
    ...snapshot,
    status: { ...snapshot.status, ...patch },
  });
  const pendingColumnCases: {
    name: string;
    snapshot: WhoIsFakerRoomSnapshot;
    key: string;
    playerIds: string[];
  }[] = [
    {
      name: "描述首轮",
      snapshot: wifSnapshot("day1"),
      key: "cycle-1",
      playerIds: [
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
      playerIds: [
        WIF_PEOPLE.kanade.id,
        WIF_PEOPLE.peach.id,
        WIF_PEOPLE.me.id,
        WIF_PEOPLE.long.id,
        WIF_PEOPLE.kita.id,
        WIF_PEOPLE.yuzu.id,
      ],
    },
    {
      name: "补充发言进行中",
      snapshot: wifSnapshot("sup2"),
      key: "sup-1",
      playerIds: [WIF_PEOPLE.kita.id, WIF_PEOPLE.yuzu.id],
    },
    {
      name: "第二次补充发言",
      snapshot: withStatus(wifSnapshot("sup2"), {
        supplementIndex: 2,
        speechOrder: [WIF_PEOPLE.me.id, WIF_PEOPLE.kita.id],
        submittedSpeechPlayerIds: [WIF_PEOPLE.me.id],
      }),
      key: "sup-2",
      playerIds: [WIF_PEOPLE.me.id, WIF_PEOPLE.kita.id],
    },
    {
      name: "平票发言进行中",
      snapshot: wifSnapshot("tie2"),
      key: "tie-1",
      playerIds: [WIF_PEOPLE.peach.id, WIF_PEOPLE.kita.id],
    },
    {
      name: "第二次平票发言",
      snapshot: withStatus(wifSnapshot("tie2"), {
        tieBreakIndex: 2,
        speechOrder: [WIF_PEOPLE.kita.id, WIF_PEOPLE.peach.id],
        submittedSpeechPlayerIds: [],
      }),
      key: "tie-2",
      playerIds: [WIF_PEOPLE.kita.id, WIF_PEOPLE.peach.id],
    },
  ];

  it.each(pendingColumnCases)("$name：进行中的列按下发顺序展开", ({ snapshot, key, playerIds }) => {
    expect(pendingColumn(snapshot.status)).toEqual({ key, playerIds });

    const model = buildDescriptionColumns(snapshot.descriptions, snapshot.status);
    const column = model.columns.find((entry) => entry.key === key);
    expect(column?.expectedPlayerIds).toEqual(new Set(playerIds));
    for (const [index, playerId] of playerIds.entries()) {
      expect(model.playerOrder.get(playerId)?.get(key)).toBe(index + 1);
    }
  });

  it("非发言阶段没有进行中的列", () => {
    expect(pendingColumn(wifSnapshot("vote1").status)).toBeNull();
    expect(pendingColumn(wifSnapshot("night1").status)).toBeNull();
  });
});
