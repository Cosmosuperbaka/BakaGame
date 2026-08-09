import { describe, expect, it } from "vitest";

import {
  applyMention,
  filterMentionCandidates,
  mentionsPlayer,
  readMentionQuery,
  splitMentions,
} from "./mentions";

const players = [
  { id: "p1", name: "小明" },
  { id: "p2", name: "小明的哥哥" },
  { id: "p3", name: "Ada Lovelace" },
];

describe("chat mentions", () => {
  it("splits a message into text and mention segments", () => {
    expect(splitMentions("你好 @小明 在吗", players)).toEqual([
      { kind: "text", text: "你好 " },
      { kind: "mention", text: "@小明", playerId: "p1" },
      { kind: "text", text: " 在吗" },
    ]);
  });

  it("prefers the longest matching name so prefixes do not win", () => {
    // 「小明」是「小明的哥哥」的前缀，按出现顺序匹配会切错人。
    expect(splitMentions("@小明的哥哥", players)).toEqual([
      { kind: "mention", text: "@小明的哥哥", playerId: "p2" },
    ]);
  });

  it("keeps names that contain spaces intact", () => {
    expect(splitMentions("@Ada Lovelace 早", players)).toEqual([
      { kind: "mention", text: "@Ada Lovelace", playerId: "p3" },
      { kind: "text", text: " 早" },
    ]);
  });

  it("leaves an at-sign that matches nobody as plain text", () => {
    expect(splitMentions("邮箱是 a@b.com", players)).toEqual([
      { kind: "text", text: "邮箱是 a@b.com" },
    ]);
  });

  it("reports whether a specific player was mentioned", () => {
    expect(mentionsPlayer("@小明 看这里", "p1", players)).toBe(true);
    expect(mentionsPlayer("@小明 看这里", "p2", players)).toBe(false);
  });

  it("reads the mention query only while it is still being typed", () => {
    expect(readMentionQuery("你好 @小", 5)).toEqual({ query: "小", start: 3 });
    // 连续空白说明这次提及已经写完，候选不该继续挂着。
    expect(readMentionQuery("@小明  然后", 7)).toBeNull();
    expect(readMentionQuery("没有提及", 4)).toBeNull();
  });

  it("filters candidates case-insensitively", () => {
    expect(filterMentionCandidates(players, "ada").map((player) => player.id)).toEqual(["p3"]);
    expect(filterMentionCandidates(players, "")).toHaveLength(3);
  });

  it("inserts the picked name and leaves the caret after a trailing space", () => {
    expect(applyMention("你好 @小", 3, 5, "小明")).toEqual({
      value: "你好 @小明 ",
      caret: 7,
    });
  });
});
