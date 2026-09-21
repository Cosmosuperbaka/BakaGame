import { describe, expect, it } from "vitest";

import type { DescriptionRecord, PublicPlayerView } from "@/types";

import {
  buildDescriptionColumns,
  descriptionCellShade,
  descriptionCellShadeForPlayer,
  speechOrdersByColumn,
  type SpeechStatus,
} from "./DescriptionColumns";

const description = (
  id: string,
  playerId: string,
  kind: DescriptionRecord["kind"],
  index = 1,
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
      status,
    );

    expect(model.columns.map(({ key }) => key)).toEqual(["sup-1", "sup-3"]);
    expect(model.columns.find(({ key }) => key === "sup-1")?.expectedPlayerIds).toEqual(
      new Set(["p1"]),
    );
    expect(model.columns.find(({ key }) => key === "sup-3")?.expectedPlayerIds).toEqual(
      new Set(["p1", "p2", "p3"]),
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

  it("numbers speech order per column so each round has its own sequence", () => {
    const roundOne = [
      { ...description("c1-p1", "p1", "description"), cycle: 1 },
      { ...description("c1-p2", "p2", "description"), cycle: 1 },
    ];
    const roundTwo = [
      { ...description("c2-p1", "p1", "description"), cycle: 2 },
      { ...description("c2-p2", "p2", "description"), cycle: 2 },
    ];

    const model = buildDescriptionColumns(
      [...roundOne, ...roundTwo],
      undefined,
      // 两轮的随机顺序不同：p2 第一轮先手，第二轮反而是 p1 先手。
      { "cycle-1": ["p2", "p1"], "cycle-2": ["p1", "p2"] },
    );

    expect(model.orderByColumn.get("cycle-1")?.get("p2")).toBe(1);
    expect(model.orderByColumn.get("cycle-1")?.get("p1")).toBe(2);
    // 第二轮里 p1 反而先发言，与第一轮的名次无关。
    expect(model.orderByColumn.get("cycle-2")?.get("p1")).toBe(1);
    expect(model.orderByColumn.get("cycle-2")?.get("p2")).toBe(2);
  });

  it("falls back to submission time when a column has no explicit order", () => {
    // 服务端只下发当前子阶段的顺序，历史列取不到，必须仍能给出稳定名次。
    const later = { ...description("late", "p2", "description"), createdAt: 200 };
    const earlier = { ...description("early", "p1", "description"), createdAt: 100 };

    const model = buildDescriptionColumns([later, earlier]);

    expect(model.orderByColumn.get("cycle-1")?.get("p1")).toBe(1);
    expect(model.orderByColumn.get("cycle-1")?.get("p2")).toBe(2);
  });

  it("derives the in-progress column order from the server speech order", () => {
    const status: SpeechStatus = {
      phase: "description",
      started: true,
      day: 3,
      speechMode: "normal",
      speechOrder: ["p3", "p1"],
    };

    expect(speechOrdersByColumn(status)).toEqual({ "cycle-3": ["p3", "p1"] });
    expect(speechOrdersByColumn(undefined)).toEqual({});
  });
});
