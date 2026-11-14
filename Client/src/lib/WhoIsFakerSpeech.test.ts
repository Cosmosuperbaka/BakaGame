import { describe, expect, it } from "vitest";

import type { WhoIsFakerRoomSnapshot } from "@bakagame/shared";

import { wifSnapshot, WIF_PEOPLE } from "@/stories/fixtures/WhoIsFaker";
import { speechModeOf, speechOrderOf, submittedOf } from "./WhoIsFakerSpeech";

const withStatus = (
  snapshot: WhoIsFakerRoomSnapshot,
  patch: Partial<WhoIsFakerRoomSnapshot["status"]>
) => ({ ...snapshot, status: { ...snapshot.status, ...patch } });

// 三种发言模式各至少两组快照：模式、顺序与已提交名单都取自服务端下发的状态。
const speechCases: {
  name: string;
  snapshot: WhoIsFakerRoomSnapshot;
  mode: "normal" | "supplement" | "tieBreak";
  order: string[];
  submitted: string[];
}[] = [
  {
    name: "描述首轮全员已交",
    snapshot: wifSnapshot("day1"),
    mode: "normal",
    order: [
      WIF_PEOPLE.peach.id,
      WIF_PEOPLE.azumi.id,
      WIF_PEOPLE.me.id,
      WIF_PEOPLE.kanade.id,
      WIF_PEOPLE.kita.id,
      WIF_PEOPLE.long.id,
      WIF_PEOPLE.yuzu.id,
      WIF_PEOPLE.stone.id,
    ],
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
    mode: "normal",
    order: [
      WIF_PEOPLE.kanade.id,
      WIF_PEOPLE.peach.id,
      WIF_PEOPLE.me.id,
      WIF_PEOPLE.long.id,
      WIF_PEOPLE.kita.id,
      WIF_PEOPLE.yuzu.id,
    ],
    submitted: [WIF_PEOPLE.kanade.id, WIF_PEOPLE.peach.id, WIF_PEOPLE.long.id, WIF_PEOPLE.yuzu.id],
  },
  {
    name: "补充发言进行中",
    snapshot: wifSnapshot("sup2"),
    mode: "supplement",
    order: [WIF_PEOPLE.kita.id, WIF_PEOPLE.yuzu.id],
    submitted: [WIF_PEOPLE.kita.id],
  },
  {
    name: "第二次补充发言",
    snapshot: withStatus(wifSnapshot("sup2"), {
      supplementIndex: 2,
      speechOrder: [WIF_PEOPLE.me.id, WIF_PEOPLE.kita.id],
      submittedSpeechPlayerIds: [WIF_PEOPLE.me.id],
    }),
    mode: "supplement",
    order: [WIF_PEOPLE.me.id, WIF_PEOPLE.kita.id],
    submitted: [WIF_PEOPLE.me.id],
  },
  {
    name: "平票发言进行中",
    snapshot: wifSnapshot("tie2"),
    mode: "tieBreak",
    order: [WIF_PEOPLE.peach.id, WIF_PEOPLE.kita.id],
    submitted: [WIF_PEOPLE.peach.id],
  },
  {
    name: "第二次平票发言",
    snapshot: withStatus(wifSnapshot("tie2"), {
      tieBreakIndex: 2,
      speechOrder: [WIF_PEOPLE.kita.id, WIF_PEOPLE.peach.id],
      submittedSpeechPlayerIds: [],
    }),
    mode: "tieBreak",
    order: [WIF_PEOPLE.kita.id, WIF_PEOPLE.peach.id],
    submitted: [],
  },
];

describe("WhoIsFakerSpeech", () => {
  it.each(speechCases)("$name", ({ snapshot, mode, order, submitted }) => {
    expect(speechModeOf(snapshot.status)).toBe(mode);
    expect(speechOrderOf(snapshot.status)).toEqual(order);
    expect(submittedOf(snapshot.status)).toEqual(new Set(submitted));
  });

  it("三个读取函数原样透出下发值，不由阶段推断", () => {
    const status = wifSnapshot("vote1").status;
    expect(speechModeOf({ ...status, speechMode: "supplement" })).toBe("supplement");
    expect(speechOrderOf({ ...status, speechOrder: ["a"] })).toEqual(["a"]);
    expect(submittedOf({ ...status, submittedSpeechPlayerIds: ["a"] })).toEqual(new Set(["a"]));
  });

  it("非发言阶段下发 normal 与空名单", () => {
    const status = wifSnapshot("vote1").status;
    expect(speechModeOf(status)).toBe("normal");
    expect(speechOrderOf(status)).toEqual([]);
    expect(submittedOf(status)).toEqual(new Set());
  });
});
