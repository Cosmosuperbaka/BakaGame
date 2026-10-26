import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { SONG_PEOPLE, songPlayer, songSnapshot } from "@/stories/fixtures/SonGuessr";
import { SongWaitingPhase } from "./SongWaitingPhase";

const { host, me } = SONG_PEOPLE;
const run = vi.fn(async () => {});

const readyPlayers = () => [
  songPlayer(host, { isReady: true, isHost: true }),
  songPlayer(me, { isReady: true }),
];

/** 房主视角：两平台是并列可选项，任一可用就能开局，与文案一起断言。 */
describe("猜歌等待页开局条件", () => {
  it.each([
    ["只有网易云", { musicAccountReady: true, qqMusicAccountReady: false }, true],
    ["只有 QQ 音乐", { musicAccountReady: false, qqMusicAccountReady: true }, true],
    ["两平台都有", { musicAccountReady: true, qqMusicAccountReady: true }, true],
    ["两平台都无", { musicAccountReady: false, qqMusicAccountReady: false }, false],
  ])("房主 · %s", (_label, accounts, canStart) => {
    render(
      <SongWaitingPhase
        snapshot={songSnapshot({ players: readyPlayers(), ...accounts })}
        me={readyPlayers()[0]}
        isHost
        run={run}
      />
    );
    const button = screen.getByRole<HTMLButtonElement>("button", {
      name: canStart ? "开始游戏" : "请先登录网易云或 QQ 音乐账号",
    });
    expect(button.disabled).toBe(!canStart);
  });

  it("单人视角：只有 QQ 音乐也能开始", () => {
    render(
      <SongWaitingPhase
        snapshot={songSnapshot({ solo: true, musicAccountReady: false, qqMusicAccountReady: true })}
        isHost
        run={run}
      />
    );
    expect(screen.getByRole("button", { name: "开始游戏" })).toBeEnabled();
  });

  it("单人视角：两平台都无时提示登录网易云或 QQ 音乐", () => {
    render(
      <SongWaitingPhase
        snapshot={songSnapshot({
          solo: true,
          musicAccountReady: false,
          qqMusicAccountReady: false,
        })}
        isHost
        run={run}
      />
    );
    expect(screen.getByRole("button", { name: "请先登录网易云或 QQ 音乐账号" })).toBeDisabled();
  });
});
