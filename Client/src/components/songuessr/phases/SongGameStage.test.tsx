import { render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SonGuessrPlayerView, SonGuessrPrivateState } from "@bakagame/shared";
import {
  choosingSnapshot,
  playingSnapshot,
  roundResultSnapshot,
  SONG_PEOPLE,
  songPlayer,
  songPrivate,
  songSettings,
  submittingSnapshot,
} from "@/stories/fixtures/SonGuessr";
import type { SongGameAreaProps } from "./SongGameAreaProps";
import { GameStage, SongGameArea } from "./SongGameStage";

// 歌词播放器的排版与媒体演出由歌词专项用例与浏览器回归覆盖；这里只记它收到的歌词。
const lyricLines: unknown[] = [];
vi.mock("@/components/songuessr/lyrics/SongLyricPlayer", () => ({
  SongLyricPlayer: ({ lines }: { lines: unknown[] }) => {
    lyricLines.push(lines);
    return <div data-testid="lyric-player" />;
  },
}));

const { me, host } = SONG_PEOPLE;

const props = (overrides: Partial<SongGameAreaProps> = {}): SongGameAreaProps => ({
  snapshot: playingSnapshot(),
  privateState: songPrivate({ canGuess: true, canGiveUp: true, remainingGuesses: 2 }),
  me: songPlayer(me, { roundStatus: "guessing" }),
  isHost: false,
  volume: 0.5,
  onVolumeChange: vi.fn(),
  audioStatus: "ready",
  audioPlaybackState: "idle",
  onPlayAudio: vi.fn(),
  onRetryAudio: vi.fn(),
  onSelectSearchSong: vi.fn(async () => {}),
  run: vi.fn(async () => {}),
  ...overrides,
});

const withPrivate = (
  privateState: Partial<SonGuessrPrivateState>,
  me?: Partial<SonGuessrPlayerView>
) =>
  props({
    privateState: songPrivate({ canGuess: false, canGiveUp: false, ...privateState }),
    me: songPlayer(SONG_PEOPLE.me, { roundStatus: "guessing", ...me }),
  });

beforeEach(() => {
  lyricLines.length = 0;
});
afterEach(() => vi.restoreAllMocks());

describe("对局舞台按阶段分派", () => {
  it("等待阶段进入等待页，房主看到开始按钮", () => {
    render(
      <GameStage
        {...props({
          snapshot: { ...playingSnapshot(), phase: "waiting", currentRound: undefined },
          isHost: true,
          me: songPlayer(host, { isHost: true }),
        })}
      />
    );
    expect(screen.getByRole("button", { name: /开始游戏|请先登录/ })).toBeInTheDocument();
  });

  it("指定出题人、手动出题、作答、结算各进各的阶段", () => {
    const { rerender } = render(<GameStage {...props({ snapshot: choosingSnapshot() })} />);
    expect(screen.getByRole("heading", { name: "指定出题人" })).toBeInTheDocument();

    rerender(
      <GameStage
        {...props({
          snapshot: submittingSnapshot(),
          privateState: songPrivate({ canSubmitSong: true }),
        })}
      />
    );
    expect(screen.getByRole("heading", { name: "轮到你出题" })).toBeInTheDocument();

    rerender(<GameStage {...props()} />);
    expect(screen.getByRole("heading", { name: "听歌猜曲" })).toBeInTheDocument();

    rerender(<GameStage {...props({ snapshot: roundResultSnapshot() })} />);
    expect(screen.getByRole("heading", { name: "答案揭晓" })).toBeInTheDocument();
  });

  it("作答阶段缺回合数据、结算阶段缺总结时退回等待页而不是白屏", () => {
    const { rerender } = render(
      <GameStage
        {...props({
          snapshot: { ...playingSnapshot(), currentRound: undefined },
          isHost: true,
          me: songPlayer(host, { isHost: true }),
        })}
      />
    );
    expect(screen.queryByRole("heading", { name: "听歌猜曲" })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: /开始游戏|请先登录/ })).toBeInTheDocument();

    rerender(
      <GameStage {...props({ snapshot: { ...roundResultSnapshot(), roundSummary: undefined } })} />
    );
    expect(screen.queryByRole("heading", { name: "答案揭晓" })).not.toBeInTheDocument();
  });

  it("测试房间才挂测试控制器", () => {
    const { rerender } = render(<SongGameArea {...props()} />);
    expect(screen.queryByText("测试控制器")).not.toBeInTheDocument();
    rerender(
      <SongGameArea {...props({ snapshot: playingSnapshot({ testMode: true }), isHost: true })} />
    );
    expect(screen.getByText("测试控制器")).toBeInTheDocument();
  });
});

describe("作答阶段：本人的作答进度", () => {
  it("还能猜：出现猜测栏，剩余次数与投降按钮在位", () => {
    render(<GameStage {...props()} />);
    expect(screen.getByRole("region", { name: "提交猜测" })).toBeInTheDocument();
    expect(screen.getByText("剩余 2 次猜测")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "投降" })).toBeInTheDocument();
  });

  it("音频未就绪：不能猜也不能投降，只写准备中", () => {
    render(<GameStage {...withPrivate({ remainingGuesses: 2 })} />);
    expect(screen.getByText("音频准备中，请稍候…")).toBeInTheDocument();
    expect(screen.queryByRole("region", { name: "提交猜测" })).not.toBeInTheDocument();
  });

  it.each([
    ["猜中", { me: { roundStatus: "correct" as const } }, "猜中了，等待其他玩家"],
    ["队友猜中", { me: { roundStatus: "teamCorrect" as const } }, "队友已猜中，等待其他玩家"],
    ["已投降", { remainingGuesses: 0, gaveUp: true }, "你已放弃本回合，等待其他玩家"],
    ["次数用尽", { remainingGuesses: 0 }, "猜测次数已用完，等待其他玩家"],
  ])("%s：猜测栏换成回执", (name, patch, receipt) => {
    const {
      me: mePatch,
      gaveUp,
      ...privatePatch
    } = patch as {
      me?: Partial<SonGuessrPlayerView>;
      gaveUp?: boolean;
      remainingGuesses?: number;
    };
    render(
      <GameStage
        {...withPrivate(
          {
            ...privatePatch,
            visibleAttempts: gaveUp
              ? [
                  {
                    id: "a1",
                    playerId: me.id,
                    playerName: me.name,
                    roundNumber: 3,
                    sequence: 1,
                    result: "gaveUp",
                    createdAt: 1,
                  } as never,
                ]
              : [],
          },
          mePatch ?? { roundStatus: "finished" }
        )}
      />
    );
    expect(screen.getByText(receipt)).toBeInTheDocument();
    expect(screen.queryByRole("region", { name: "提交猜测" })).not.toBeInTheDocument();
    expect(name).toBeTruthy();
  });

  it("单人模式的回执不再等别的玩家", () => {
    render(
      <GameStage
        {...withPrivate({ remainingGuesses: 0 }, { roundStatus: "finished" })}
        snapshot={playingSnapshot({ solo: true })}
      />
    );
    expect(screen.getByText("猜测次数已用完")).toBeInTheDocument();
  });

  it("旁观者只看到旁观说明，没有作答控件", () => {
    render(
      <GameStage {...withPrivate({}, { membership: "spectator", roundStatus: "spectator" })} />
    );
    expect(screen.getByText("你正在旁观本轮游戏")).toBeInTheDocument();
    expect(screen.queryByRole("region", { name: "提交猜测" })).not.toBeInTheDocument();
  });

  it("出题人猜测结束后不再出控件", () => {
    render(
      <GameStage
        {...withPrivate({ isSubmitter: true, remainingGuesses: 0 }, { roundStatus: "submitter" })}
      />
    );
    expect(screen.queryByRole("region", { name: "提交猜测" })).not.toBeInTheDocument();
    expect(screen.queryByText(/猜测次数已用完/)).not.toBeInTheDocument();
  });

  it("听歌识番：猜测栏只给番剧搜索，没有歌曲搜索", () => {
    render(
      <GameStage
        {...props({
          snapshot: playingSnapshot({ settings: songSettings({ questionType: "anime" }) }),
        })}
      />
    );
    expect(screen.getByRole("combobox", { name: "搜索番剧" })).toBeInTheDocument();
    expect(screen.queryByRole("combobox", { name: "搜索歌曲" })).not.toBeInTheDocument();
  });

  it("听歌识曲：猜测栏只给歌曲搜索", () => {
    render(<GameStage {...props()} />);
    expect(screen.getByRole("combobox", { name: "搜索歌曲" })).toBeInTheDocument();
    expect(screen.queryByRole("combobox", { name: "搜索番剧" })).not.toBeInTheDocument();
  });
});

describe("作答阶段：歌词与提示", () => {
  it("没有歌词的回合重渲染时，传给歌词播放器的是同一个空数组", () => {
    const noLyrics = playingSnapshot({
      currentRound: {
        roundNumber: 3,
        submitterPlayerId: SONG_PEOPLE.peach.id,
        audioUrl: "",
        lyricClip: { startTime: 0, endTime: 10_000, lines: undefined } as never,
      },
    });
    const { rerender } = render(<GameStage {...props({ snapshot: noLyrics })} />);
    rerender(<GameStage {...props({ snapshot: noLyrics, volume: 0.9 })} />);
    expect(lyricLines.length).toBeGreaterThanOrEqual(2);
    expect(new Set(lyricLines).size).toBe(1);
  });

  it("关闭歌词时给同一外壳的说明，不挂歌词播放器", () => {
    render(
      <GameStage
        {...props({
          snapshot: playingSnapshot({ settings: songSettings({ showLyrics: false }) }),
        })}
      />
    );
    expect(screen.getByText("本房间已关闭歌词提示，请根据音乐进行猜测")).toBeInTheDocument();
    expect(screen.queryByTestId("lyric-player")).not.toBeInTheDocument();
  });

  it("音频提示控件：失败给重试、待播放给播放、结束给重播，随状态切换", () => {
    const onRetryAudio = vi.fn();
    const onPlayAudio = vi.fn();
    const { rerender } = render(
      <GameStage {...props({ audioStatus: "error", onRetryAudio, onPlayAudio })} />
    );
    screen.getByRole("button", { name: "加载失败，重试" }).click();
    expect(onRetryAudio).toHaveBeenCalledTimes(1);

    rerender(<GameStage {...props({ audioStatus: "ready", onRetryAudio, onPlayAudio })} />);
    screen.getByRole("button", { name: "播放片段" }).click();
    expect(onPlayAudio).toHaveBeenCalledTimes(1);

    rerender(
      <GameStage {...props({ audioPlaybackState: "completed", onRetryAudio, onPlayAudio })} />
    );
    screen.getByRole("button", { name: "重播音频" }).click();
    expect(onPlayAudio).toHaveBeenCalledTimes(2);
  });

  it("加载中与播放中只是状态，不给按钮", () => {
    const { rerender } = render(<GameStage {...props({ audioStatus: "loading" })} />);
    expect(screen.getByText("音频加载中")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /播放|重试|重播/ })).not.toBeInTheDocument();

    rerender(<GameStage {...props({ audioPlaybackState: "playing" })} />);
    expect(screen.getByText("正在播放")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /播放片段|重播|重试/ })).not.toBeInTheDocument();
  });
});
