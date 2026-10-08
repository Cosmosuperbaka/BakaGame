import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import {
  choosingSnapshot,
  guesserPrivate,
  noPending,
  playingSnapshot,
  SONG_PEOPLE,
  songAttempt,
  songPlayer,
  songPrivate,
  songSettings,
  songSnapshot,
  submitterPrivate,
  teamPlayingPlayers,
  teamWaitingPlayers,
} from "@/stories/fixtures/SonGuessr";
import { GameStage, type SongGameAreaProps } from "./SongGameStage";
import { SongWaitingPhase } from "./SongWaitingPhase";

const { host, me, kanade, long, azumi } = SONG_PEOPLE;

function stage(overrides: Partial<SongGameAreaProps>) {
  const props: SongGameAreaProps = {
    // 关闭歌词：歌词播放器依赖 jsdom 没有的 Web Animations，组队断言与它无关
    snapshot: playingSnapshot({ players: teamPlayingPlayers(), settings: songSettings({ showLyrics: false }) }),
    privateState: songPrivate(),
    isHost: false,
    volume: 0.5,
    onVolumeChange: vi.fn(),
    audioStatus: "ready",
    audioPlaybackState: "idle",
    onPlayAudio: vi.fn(),
    onRetryAudio: vi.fn(),
    onSelectSearchSong: vi.fn(async () => {}),
    run: vi.fn(async () => {}),
    isPending: noPending,
    ...overrides,
  };
  return render(<GameStage {...props} />);
}

const teamView = (id: string) => teamPlayingPlayers().find((player) => player.id === id);

describe("猜歌组队", () => {
  it("等待页队伍面板点格即发送换队，旁观者没有面板", async () => {
    const user = userEvent.setup();
    const run = vi.fn(async () => {});
    const players = teamWaitingPlayers();
    const view = render(
      <SongWaitingPhase snapshot={songSnapshot({ players })} me={players.find((player) => player.id === me.id)} isHost={false} run={run} />,
    );
    const group = screen.getByRole("radiogroup", { name: "选择队伍" });
    expect(within(group).getByRole("radio", { name: "1 队，2 人" })).toBeChecked();
    await user.click(within(group).getByText("3 队"));
    expect(run).toHaveBeenCalledWith("song.player.setTeam", { team: 3 });

    const spectator = songPlayer(me, { membership: "spectator", roundStatus: "spectator" });
    view.rerender(<SongWaitingPhase snapshot={songSnapshot({ players: [...players.filter((player) => player.id !== me.id), spectator] })} me={spectator} isHost={false} run={run} />);
    expect(screen.queryByRole("radiogroup", { name: "选择队伍" })).not.toBeInTheDocument();
  });

  it("手动出题且暂无可选出题人时，房主不能开局", () => {
    const players = [songPlayer(host, { isReady: true, team: 1, isHost: true }), songPlayer(me, { isReady: true, team: 1 })];
    render(<SongWaitingPhase snapshot={songSnapshot({ players })} me={players[0]} isHost submitterCandidateIds={[]} run={vi.fn(async () => {})} />);
    expect(screen.getByRole("button", { name: "暂无可选出题人" })).toBeDisabled();
  });

  it("可见记录含队友猜测时标为本队猜测并写明猜测者", () => {
    stage({
      me: teamView(me.id),
      privateState: guesserPrivate(Date.now() + 60_000, {
        visibleAttempts: [songAttempt(host, 1, 8, "wrong"), songAttempt(me, 2, 10, "wrong")],
      }),
    });
    expect(screen.getByRole("heading", { name: "本队猜测" })).toBeInTheDocument();
    expect(screen.getByText(new RegExp(`^${host.name}：`))).toBeInTheDocument();
  });

  it("出题人的队友本局观战：看全房猜测，不出现猜测栏", () => {
    stage({ me: teamView(kanade.id), privateState: submitterPrivate({ playerId: kanade.id, isSubmitter: false, teamObserver: true }) });
    expect(screen.getByText("队友出题，你本局观战")).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "全房猜测" })).toBeInTheDocument();
    expect(screen.queryByRole("region", { name: "提交猜测" })).not.toBeInTheDocument();
  });

  it("队友猜中后给出队伍猜中回执", () => {
    stage({
      me: teamView(long.id),
      privateState: songPrivate({ playerId: long.id, remainingGuesses: 1, visibleAttempts: [songAttempt(azumi, 2, 20, "correct")] }),
    });
    expect(screen.getByText("队友已猜中，等待其他玩家")).toBeInTheDocument();
  });

  it("指定出题人只列服务端候选，组队时名后带队伍", async () => {
    const user = userEvent.setup();
    const run = vi.fn(async () => {});
    const players = teamPlayingPlayers().map((player) => ({ ...player, roundStatus: "waiting" as const }));
    stage({
      snapshot: choosingSnapshot({ players }),
      privateState: songPrivate({ playerId: host.id, submitterCandidateIds: [host.id, me.id] }),
      isHost: true,
      run,
    });
    expect(screen.getByText("指定后其队友本局一起观战")).toBeInTheDocument();
    expect(screen.queryByText(new RegExp(kanade.name))).not.toBeInTheDocument();
    await user.click(screen.getByText(`${me.name}（1 队）`));
    expect(run).toHaveBeenCalledWith("song.game.chooseSubmitter", { playerId: me.id });
  });
});
