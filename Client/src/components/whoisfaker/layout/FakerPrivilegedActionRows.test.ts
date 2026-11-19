import { describe, expect, it } from "vitest";
import { ABSTAIN_TARGET_ID } from "@bakagame/shared/values";
import type { PublicPlayerView, WhoIsFakerRoomSnapshot } from "@bakagame/shared";
import { wifPlayer, wifSnapshot, WIF_PEOPLE } from "@/stories/fixtures/WhoIsFaker";
import {
  buildNightRows,
  buildVoteRows,
  countVotes,
  voteTargetsOf,
} from "./FakerPrivilegedActionRows";

const { me, peach, kita, azumi, kanade } = WIF_PEOPLE;

/** 四名存活玩家（甲=我、乙=桃子、丙=北川、丁=阿澄），天使奏不参与夜晚行动。 */
const alive = (person: (typeof WIF_PEOPLE)[keyof typeof WIF_PEOPLE]): PublicPlayerView =>
  wifPlayer(person, { roundStatus: "alive" });

function setup(phase: "voting" | "tieBreak") {
  const base = wifSnapshot("vote3");
  const snapshot: WhoIsFakerRoomSnapshot = {
    ...base,
    status: {
      ...base.status,
      phase,
      ...(phase === "tieBreak" ? { tieBreakCandidateIds: [peach.id, kita.id] } : {}),
    },
    players: [alive(me), alive(peach), alive(kita), alive(azumi), alive(kanade)],
  };
  const questionerView = [
    { playerId: me.id, role: "civilian" as const, side: "good" as const, alive: true },
    { playerId: peach.id, role: "undercover" as const, side: "undercover" as const, alive: true },
    { playerId: kita.id, role: "blank" as const, side: "blank" as const, alive: true },
    { playerId: azumi.id, role: "civilian" as const, side: "good" as const, alive: true },
    { playerId: kanade.id, role: "angel" as const, side: "good" as const, alive: true },
  ];
  return { snapshot, questionerView };
}

describe("投票预览行", () => {
  it("没投的显示等待，弃票与投人分别显示", () => {
    const { snapshot, questionerView } = setup("voting");
    const rows = buildVoteRows(snapshot, questionerView, {
      votes: [
        { voterId: me.id, targetId: peach.id },
        { voterId: azumi.id, targetId: ABSTAIN_TARGET_ID },
      ],
      nightActions: [],
    });
    const byId = new Map(rows.map((row) => [row.id, row]));
    expect(byId.get(me.id)).toMatchObject({ value: peach.name, pending: false, role: "civilian" });
    expect(byId.get(azumi.id)).toMatchObject({ value: "弃票", pending: false });
    expect(byId.get(kita.id)).toMatchObject({ value: "等待投票", pending: true });
  });

  it("平票 PK 中候选人本人不在投票人里，目标只列候选人", () => {
    const { snapshot, questionerView } = setup("tieBreak");
    const rows = buildVoteRows(snapshot, questionerView, { votes: [], nightActions: [] });
    expect(rows.map((row) => row.id).sort()).toEqual([me.id, azumi.id, kanade.id].sort());
    expect(
      voteTargetsOf(snapshot)
        .map((player) => player.id)
        .sort()
    ).toEqual([peach.id, kita.id].sort());
  });

  it("统计把弃票计在内", () => {
    const counts = countVotes([
      { voterId: "a", targetId: "x" },
      { voterId: "b", targetId: "x" },
      { voterId: "c", targetId: ABSTAIN_TARGET_ID },
    ]);
    expect(counts.get("x")).toBe(2);
    expect(counts.get(ABSTAIN_TARGET_ID)).toBe(1);
  });
});

describe("夜晚预览行", () => {
  it("只列存活的平民与卧底，无目标显示无行动，没动作的显示等待", () => {
    const { snapshot, questionerView } = setup("voting");
    const rows = buildNightRows(snapshot, questionerView, {
      votes: [],
      nightActions: [{ actorId: me.id, targetId: azumi.id }, { actorId: peach.id }],
    });
    // 白板与天使夜里没有行动，不列入
    expect(rows.map((row) => row.id).sort()).toEqual([me.id, peach.id, azumi.id].sort());
    const byId = new Map(rows.map((row) => [row.id, row]));
    expect(byId.get(me.id)).toMatchObject({ value: azumi.name, pending: false });
    expect(byId.get(peach.id)).toMatchObject({ value: "无行动", pending: false });
    expect(byId.get(azumi.id)).toMatchObject({ value: "等待行动", pending: true });
  });
});
