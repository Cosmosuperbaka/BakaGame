import { render, screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { BANGUMI_TRACK_KIND_LABELS } from "@bakagame/shared/values";
import {
  animeRoundSummary,
  roundResultSnapshot,
  songPrivate,
  songSettings,
} from "@/stories/fixtures/SonGuessr";
import { SongRoundResultPhase, SongScoreTable } from "./SongRoundResultPhase";

const scores = [
  { playerId: "p1", playerName: "甲", score: 12, delta: 12, correctGuesses: 1, totalGuesses: 1 },
];

describe("猜歌结算得分表", () => {
  it("有计分拆解时给出难度分与逐人速度/精度系数", () => {
    render(
      <SongScoreTable
        scores={scores}
        contributors={["p1"]}
        breakdown={{
          difficulty: 0.29,
          answerableCount: 1,
          players: [{ playerId: "p1", speed: 1.16, precision: 1, score: 12 }],
        }}
      />
    );
    expect(screen.getByRole("heading", { name: "得分统计 · 难度 0.29" })).toBeInTheDocument();
    expect(screen.getByText(/^速度 1\.16/)).toBeInTheDocument();
    expect(screen.getByText("精度 1.00")).toBeInTheDocument();
  });

  it("旧口径或历史对局没有拆解时退回纯得分表", () => {
    render(<SongScoreTable scores={scores} contributors={["p1"]} />);
    expect(screen.getByRole("heading", { name: "得分统计" })).toBeInTheDocument();
    expect(screen.queryByText(/速度/)).not.toBeInTheDocument();
  });
});

describe("猜歌答案揭晓页", () => {
  const renderPhase = (
    overrides: Partial<Parameters<typeof SongRoundResultPhase>[0]> & {
      snapshot?: ReturnType<typeof roundResultSnapshot>;
    } = {}
  ) =>
    render(
      <SongRoundResultPhase
        snapshot={roundResultSnapshot()}
        privateState={songPrivate()}
        isHost={false}
        run={vi.fn(async () => {})}
        {...overrides}
      />
    );

  it("猜番：答案卡写番名、原名、年份评分与前五个标签，关联歌曲带曲目类型徽章", () => {
    renderPhase({
      snapshot: roundResultSnapshot({
        settings: songSettings({ questionType: "anime" }),
        roundSummary: animeRoundSummary(),
      }),
    });

    expect(screen.getByRole("heading", { level: 3, name: "夏空旋律" })).toBeInTheDocument();
    expect(screen.getByText("夏空メロディー", { selector: "p" })).toBeInTheDocument();
    expect(screen.getAllByText("2021").length).toBeGreaterThan(0);
    expect(screen.getByText("评分 7.8")).toBeInTheDocument();
    // 六个标签只显示前五个。
    expect(screen.getByText("日常")).toBeInTheDocument();
    expect(screen.queryByText("治愈")).not.toBeInTheDocument();
    const related = screen.getByText("关联歌曲").parentElement!.parentElement!;
    expect(within(related).getByText(BANGUMI_TRACK_KIND_LABELS.opening)).toBeInTheDocument();
  });

  it("猜曲：只有歌曲答案卡，没有关联歌曲小节", () => {
    renderPhase();
    expect(screen.getByRole("heading", { name: "答案揭晓" })).toBeInTheDocument();
    expect(screen.queryByText("关联歌曲")).not.toBeInTheDocument();
  });

  it("房主：返回等待阶段与再来一轮，按在途命令显示加载并互斥禁用", () => {
    const run = vi.fn(async () => {});
    const { rerender } = renderPhase({ isHost: true, run });
    expect(screen.getByRole("button", { name: "返回等待阶段" })).toBeEnabled();
    expect(screen.getByRole("button", { name: "再来一轮" })).toBeEnabled();

    rerender(
      <SongRoundResultPhase
        snapshot={roundResultSnapshot()}
        privateState={songPrivate()}
        isHost
        run={run}
        isPending={(type) => type === "song.game.nextRound"}
      />
    );
    expect(screen.getByRole("button", { name: "返回等待阶段" })).toBeDisabled();
    expect(screen.getByRole("button", { name: /再来一轮/ })).toBeDisabled();
  });

  it("自动出题没有可用账号：再来一轮置灰并说明出路", () => {
    renderPhase({
      isHost: true,
      snapshot: roundResultSnapshot({
        settings: songSettings({ questionMode: "automatic" }),
        musicAccountReady: false,
        qqMusicAccountReady: false,
      }),
    });
    expect(screen.getByRole("button", { name: "再来一轮" })).toBeDisabled();
    expect(screen.getByText(/自动出题需要可用的网易云或 QQ 音乐账号/)).toBeInTheDocument();
  });

  it("单人模式把返回按钮写成结束本局", () => {
    renderPhase({
      isHost: true,
      snapshot: roundResultSnapshot({ solo: true, hostPlayerId: "me" }),
    });
    expect(screen.getByRole("button", { name: "结束本局" })).toBeInTheDocument();
  });

  it("非房主只等房主开始下一轮，没有操作按钮", () => {
    renderPhase();
    expect(screen.getByText("等待房主开始下一轮")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "再来一轮" })).not.toBeInTheDocument();
  });
});
