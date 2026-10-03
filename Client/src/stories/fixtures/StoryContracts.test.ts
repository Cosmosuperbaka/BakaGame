import { describe, expect, it, vi } from "vitest";
import type { WhoIsFakerRoomSnapshot } from "@/types";
import { ABSTAIN_TARGET_ID } from "@/types";
import { useWhoIsFakerStore } from "@/stores/UseWhoIsFakerStore";

// 本套件检查实际 fixture 与 CSF metadata 的逻辑契约，不冒充 Storybook 渲染认证。
// waitFor 单次执行真实 helper 的条件，避免让预期拒绝的静态探针等待十秒。
vi.mock("storybook/test", async () => {
  const testing = await import("@testing-library/react");
  const { default: userEvent } = await import("@testing-library/user-event");
  return { fn: vi.fn, expect, screen: testing.screen, within: testing.within, userEvent,
    waitFor: vi.fn(async (callback: () => unknown) => callback()) };
});

import {
  GameOverGoodWin, GameOverHost, GameOverUndercoverWin,
} from "@/pages/WhoIsFakerRoomPage.stories";
import lyricMeta, { Instrumental as LyricInstrumental } from "@/components/songuessr/lyrics/SongLyricPlayer.stories";
import stageMeta, {
  Instrumental, LyricsHidden,
} from "@/components/songuessr/phases/SongGameStage.stories";
import { STORY_EPOCH } from "./Common";
import { WIF_PEOPLE, WIF_STAGES, wifEndingScenario, wifSnapshot } from "./WhoIsFaker";
import { waitForLyrics } from "./SonGuessr";

const ending = async (story: { beforeEach?: unknown }) => {
  await (story.beforeEach as () => unknown)();
  return useWhoIsFakerStore.getState().snapshot!;
};
// 按真实 Rules.ts 已核对的阵营口径作独立断言；客户端测试不导入服务端非共享源码。
const aliveCounts = (snapshot: WhoIsFakerRoomSnapshot) => {
  const alive = snapshot.players.filter((player) => player.roundStatus === "alive");
  return {
    good: alive.filter((player) => player.revealedRole === "civilian" || player.revealedRole === "angel").length,
    undercover: alive.filter((player) => player.revealedRole === "undercover").length,
    blank: alive.filter((player) => player.revealedRole === "blank").length,
  };
};
const at = (stage: (typeof WIF_STAGES)[number], seconds = 0) => STORY_EPOCH + (WIF_STAGES.indexOf(stage) * 90 + seconds) * 1000;
const rootWithLyrics = (ready = true, hidden = false) => {
  const root = document.createElement("div");
  const host = document.createElement("div");
  host.className = "baka-lyric-host";
  host.hidden = hidden;
  if (ready) host.dataset.ready = "true";
  root.append(host);
  return root;
};
const play = (callback: unknown, root: HTMLElement) =>
  (callback as (context: { canvasElement: HTMLElement }) => Promise<void>)({ canvasElement: root });

describe("替代结局故事使用可达的胜负和历史", () => {
  it("卧底胜在第二夜人数持平，白板已经投出且猜词失败", async () => {
    const snapshot = await ending(GameOverUndercoverWin);
    expect(snapshot.status.day).toBe(2);
    expect(aliveCounts(snapshot)).toEqual({ good: 2, undercover: 2, blank: 0 });
    expect(snapshot.summary!.winner).toBe("undercover");
    expect(snapshot.summary!.blankGuesses).toEqual([expect.objectContaining({ reason: "eliminated", success: false })]);
    expect(snapshot.summary!.voteHistory!.map((record) => [record.day, Boolean(record.tieBreak)])).toEqual([[1, false], [2, false]]);
    expect(snapshot.descriptions.every((record) => record.cycle <= 2)).toBe(true);
    expect(snapshot.chat.every((message) => message.createdAt < at("day3"))).toBe(true);
  });

  it("好人胜沿用卧底全灭时间线，但白板终局猜词失败而非虚构白板已死", async () => {
    const snapshot = await ending(GameOverGoodWin);
    expect(aliveCounts(snapshot)).toEqual({ good: 2, undercover: 0, blank: 1 });
    expect(snapshot.summary!.winner).toBe("good");
    expect(snapshot.summary!.reason).toBe("卧底全部出局，白板终局猜词失败");
    expect(snapshot.summary!.blankGuesses).toEqual([expect.objectContaining({ reason: "finale", success: false })]);
  });

  it.each([GameOverUndercoverWin, GameOverGoodWin])("投票与发言发生时玩家仍存活，结算与公开分数一致", async (story) => {
    const snapshot = await ending(story);
    const summary = snapshot.summary!;
    expect(snapshot.descriptions).toEqual(summary.descriptions);
    for (const record of summary.descriptions) {
      const player = snapshot.players.find((player) => player.id === record.playerId)!;
      expect(player.eliminatedAt === undefined || record.createdAt <= player.eliminatedAt).toBe(true);
    }
    for (const record of summary.voteHistory!) {
      const stage = record.day === 1 ? "vote1" : record.day === 2 ? record.tieBreak ? "tieVote2" : "vote2" : "vote3";
      for (const vote of record.votes) {
        for (const id of [vote.voterId, vote.targetId].filter((id) => id !== ABSTAIN_TARGET_ID)) {
          const player = snapshot.players.find((player) => player.id === id)!;
          expect(player.eliminatedAt === undefined || player.eliminatedAt > at(stage)).toBe(true);
        }
      }
    }
    const awardedIds = new Set(summary.awardedScores.map((entry) => entry.playerId));
    expect([...awardedIds].sort()).toEqual(summary.revealedRoles
      .filter(({ role }) => summary.winner === "undercover" ? role === "undercover" : role === "civilian" || role === "angel")
      .map(({ playerId }) => playerId).sort());
    expect(summary.awardedScores.every((award) => award.delta === 1)).toBe(true);
  });

  it.each(["undercover", "good"] as const)("%s 的主持人/旁观私有存活与公开名单、计分一致", (winner) => {
    const before = wifSnapshot("day1");
    for (const viewer of ["host", "spectator"] as const) {
      const { snapshot, privateState } = wifEndingScenario(winner, viewer);
      for (const assignment of privateState.questionerView!) {
        const player = snapshot.players.find((player) => player.id === assignment.playerId)!;
        expect(assignment.alive).toBe(player.roundStatus === "alive");
        expect(assignment.role).toBe(player.revealedRole);
      }
      for (const player of snapshot.players) {
        const initial = before.players.find((entry) => entry.id === player.id)!.score;
        const delta = snapshot.summary!.awardedScores.find((award) => award.playerId === player.id)?.delta ?? 0;
        expect(player.score).toBe(initial + delta);
      }
      const blank = wifEndingScenario(winner, WIF_PEOPLE.kita).privateState;
      expect(blank.blankGuessUsed).toBe(true);
      expect(blank.canSubmitBlankGuess).toBe(false);
    }
  });

  it("默认白板胜故事仍然保留成功猜词与原存活名单", async () => {
    const snapshot = await ending(GameOverHost);
    expect(snapshot.summary!.winner).toBe("blank");
    expect(snapshot.summary!.blankGuesses[0].success).toBe(true);
    expect(aliveCounts(snapshot)).toEqual({ good: 2, undercover: 0, blank: 1 });
  });
});

describe("歌词故事的可见宿主数量契约", () => {
  it.each([Instrumental, LyricsHidden])("合法零宿主的阶段故事显式通过自己的 play", async (story) => {
    expect(story.play).toBeDefined();
    await expect(play(story.play ?? stageMeta.play, document.createElement("div"))).resolves.toBeUndefined();
    await expect(play(story.play ?? stageMeta.play, rootWithLyrics())).rejects.toThrow("期望 0，实际 1");
  });
  it("纯音乐播放器故事同样显式允许零宿主", async () => {
    await expect(play(LyricInstrumental.play, document.createElement("div"))).resolves.toBeUndefined();
  });
  it.each([lyricMeta.play, stageMeta.play])("有词故事不能对零宿主、hidden、未就绪或多个宿主空集合成功", async (callback) => {
    await expect(play(callback, document.createElement("div"))).rejects.toThrow("期望 1，实际 0");
    await expect(play(callback, rootWithLyrics(true, true))).rejects.toThrow("期望 1，实际 0");
    await expect(play(callback, rootWithLyrics(false))).rejects.toThrow("尚未完成排版");
    const two = rootWithLyrics();
    two.append(rootWithLyrics().firstElementChild!);
    await expect(play(callback, two)).rejects.toThrow("期望 1，实际 2");
    await expect(play(callback, rootWithLyrics())).resolves.toBeUndefined();
  });
  it("默认 helper 仍要求一个真正可见且 ready 的宿主", async () => {
    await expect(waitForLyrics(document.createElement("div"))).rejects.toThrow("期望 1，实际 0");
    await expect(waitForLyrics(rootWithLyrics())).resolves.toBeUndefined();
  });
});
