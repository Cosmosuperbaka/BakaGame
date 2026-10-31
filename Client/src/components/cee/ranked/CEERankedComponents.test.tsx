import type { ReactElement } from "react";
import type { CEERankedGameSummary } from "@bakagame/shared";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { describe, expect, it, vi } from "vitest";
import { TooltipProvider } from "@/components/ui/Tooltip";
import {
  RANKED_IDLE_STATE,
  rankedProfile,
  rankedQueuedState,
  rankedSeries,
} from "@/stories/fixtures/CEERanked";
import { formatRankedClock, formatRankedPoints, rankedGameHeadline } from "./CEERankedFormat";
import { CEERankedGameRecap } from "./CEERankedGameRecap";
import { CEERankedGate } from "./CEERankedGate";
import { CEERankedHome } from "./CEERankedHome";
import { CEERankedMatch } from "./CEERankedMatch";
import { CEERankedOpponentClues } from "./CEERankedOpponentClues";
import { CEERankedResultCard } from "./CEERankedResultCard";
import { CEERankedScoreboard } from "./CEERankedScoreboard";

const withProviders = (ui: ReactElement) =>
  render(
    <MemoryRouter>
      <TooltipProvider>{ui}</TooltipProvider>
    </MemoryRouter>
  );

describe("排位读数格式", () => {
  it("分数以半分为单位，整分不带小数点", () => {
    expect(formatRankedPoints(0)).toBe("0");
    expect(formatRankedPoints(0.5)).toBe("½");
    expect(formatRankedPoints(1)).toBe("1");
    expect(formatRankedPoints(1.5)).toBe("1½");
    expect(formatRankedPoints(2)).toBe("2");
  });

  it("秒数按 m:ss 展示，个位补零", () => {
    expect(formatRankedClock(0)).toBe("0:00");
    expect(formatRankedClock(65)).toBe("1:05");
    expect(formatRankedClock(185)).toBe("3:05");
  });

  it("一局标题区分猜中、认输与平局", () => {
    const game = { number: 2 } as unknown as CEERankedGameSummary;
    expect(rankedGameHeadline({ ...game, winner: null })).toBe("第 2 局 · 平局，双方都没猜中");
    expect(rankedGameHeadline({ ...game, winner: "self", reason: "solved" })).toBe(
      "第 2 局 · 你先猜中了"
    );
    expect(rankedGameHeadline({ ...game, winner: "opponent", reason: "solved" })).toBe(
      "第 2 局 · 对手先猜中了"
    );
    expect(rankedGameHeadline({ ...game, winner: "self", reason: "surrender" })).toBe(
      "第 2 局 · 对手认输"
    );
    expect(rankedGameHeadline({ ...game, winner: "opponent", reason: "surrender" })).toBe(
      "第 2 局 · 你认输了"
    );
  });
});

describe("CEERankedGate", () => {
  it("网页端口径只说需要客户端，并给出下载入口", () => {
    withProviders(<CEERankedGate reason="client" onLogin={vi.fn()} />);

    expect(screen.getByRole("heading", { name: "排位赛只在客户端开放" })).toBeInTheDocument();
    expect(screen.getByText(/排位需要使用 BakaGame 客户端并登录账号/)).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /下载客户端/ })).toHaveAttribute(
      "href",
      expect.stringContaining("http")
    );
    expect(screen.getByRole("link", { name: "返回多人模式" })).toHaveAttribute("href", "/cee");
  });

  it("客户端未登录时引导登录", async () => {
    const onLogin = vi.fn();
    withProviders(<CEERankedGate reason="login" onLogin={onLogin} />);

    expect(screen.getByRole("heading", { name: "登录后参加排位赛" })).toBeInTheDocument();
    expect(screen.getByText(/排位分与战绩记在账号上/)).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: /登录/ }));
    expect(onLogin).toHaveBeenCalledOnce();
  });
});

describe("CEERankedHome", () => {
  const props = {
    placementTotal: 5,
    pending: {},
    onQueue: vi.fn(),
    onCancel: vi.fn(),
    onPlayBot: vi.fn(),
  };

  it("资料未到时只给骨架，不给可点按钮", () => {
    withProviders(<CEERankedHome {...props} profile={null} state={RANKED_IDLE_STATE} />);

    expect(screen.getByLabelText("正在读取排位资料")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "开始匹配" })).toBeDisabled();
  });

  it("已定级时显示分数、胜负与今日人机计分", () => {
    withProviders(
      <CEERankedHome {...props} profile={rankedProfile("rated")} state={RANKED_IDLE_STATE} />
    );

    expect(screen.getByText("排位分")).toBeInTheDocument();
    expect(screen.getByText("1532")).toBeInTheDocument();
    expect(screen.getByText(/胜 13 · 负 9 · 平 1 · 今日人机计分 3 \/ 5/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "开始匹配" })).toBeEnabled();
    expect(screen.queryByText(/定级赛的对手都是人机/)).not.toBeInTheDocument();
  });

  it("定级中只给进度，按钮写作开始定级赛", () => {
    withProviders(
      <CEERankedHome {...props} profile={rankedProfile("placement")} state={RANKED_IDLE_STATE} />
    );

    expect(screen.getByText("定级赛")).toBeInTheDocument();
    expect(screen.getByText("已完成 2 / 5 场，打满后显示分数")).toBeInTheDocument();
    expect(screen.getByText(/定级赛的对手都是人机，打满 5 场后开始匹配真人/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "开始定级赛" })).toBeInTheDocument();
    expect(screen.queryByText(/今日人机计分/)).not.toBeInTheDocument();
  });

  it("没有战绩时给空态文案", () => {
    withProviders(
      <CEERankedHome {...props} profile={rankedProfile("empty")} state={RANKED_IDLE_STATE} />
    );

    expect(screen.getByText("还没有排位记录，打完第一场后显示在这里")).toBeInTheDocument();
  });

  it("战绩行区分胜负、人机、定级与未计分", () => {
    const profile = rankedProfile("rated");
    withProviders(
      <CEERankedHome
        {...props}
        profile={{
          ...profile,
          recent: [
            ...profile.recent,
            {
              seriesId: "r4",
              endedAt: Date.now() - 60_000,
              tierId: "d2",
              opponentName: "定级对手",
              opponentIsBot: false,
              outcome: "drawn",
              selfPoints: 1,
              opponentPoints: 1,
              ratingDelta: null,
              placement: true,
            },
          ],
        }}
        state={RANKED_IDLE_STATE}
      />
    );

    const rows = within(screen.getByRole("region", { name: "最近战绩" })).getAllByRole("listitem");
    expect(rows).toHaveLength(4);
    expect(rows[0]).toHaveTextContent("+15");
    expect(rows[1]).toHaveTextContent("人机");
    expect(rows[2]).toHaveTextContent("-12");
    expect(rows[3]).toHaveTextContent("定级");
  });

  it("空闲态点开始匹配交给上层排队", async () => {
    const onQueue = vi.fn();
    withProviders(
      <CEERankedHome
        {...props}
        onQueue={onQueue}
        profile={rankedProfile("rated")}
        state={RANKED_IDLE_STATE}
      />
    );

    await userEvent.click(screen.getByRole("button", { name: "开始匹配" }));
    expect(onQueue).toHaveBeenCalledOnce();
  });

  it("排队不足十秒不给先打人机，满十秒才出现并可点", async () => {
    const onPlayBot = vi.fn();
    const { unmount } = withProviders(
      <CEERankedHome
        {...props}
        onPlayBot={onPlayBot}
        profile={rankedProfile("rated")}
        state={rankedQueuedState(3_000)}
      />
    );

    expect(screen.getByText(/匹配范围 ±/)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /先打人机/ })).not.toBeInTheDocument();
    unmount();

    withProviders(
      <CEERankedHome
        {...props}
        onPlayBot={onPlayBot}
        profile={rankedProfile("rated")}
        state={rankedQueuedState(12_000)}
      />
    );
    await userEvent.click(screen.getByRole("button", { name: /先打人机/ }));
    expect(onPlayBot).toHaveBeenCalledOnce();
  });

  it("排队中取消匹配与先打人机互斥", async () => {
    const onCancel = vi.fn();
    withProviders(
      <CEERankedHome
        {...props}
        onCancel={onCancel}
        profile={rankedProfile("rated")}
        state={rankedQueuedState(12_000)}
      />
    );

    expect(screen.getByRole("button", { name: "取消匹配" })).toBeEnabled();
    await userEvent.click(screen.getByRole("button", { name: "取消匹配" }));
    expect(onCancel).toHaveBeenCalledOnce();
  });
});

describe("CEERankedScoreboard", () => {
  it("对局中给出比分、局点、难度与剩余时间", () => {
    withProviders(<CEERankedScoreboard series={rankedSeries("playing")} />);

    expect(screen.getByLabelText("比分 0 比 1")).toHaveTextContent("0");
    expect(screen.getByLabelText("第 1 局：对手赢")).toBeInTheDocument();
    expect(screen.getByLabelText("第 2 局：进行中")).toBeInTheDocument();
    expect(screen.getByLabelText("第 3 局：未开始")).toBeInTheDocument();
    expect(screen.getByText("人机")).toBeInTheDocument();
    expect(screen.getByRole("timer")).toHaveTextContent("剩余");
    expect(screen.getByRole("timer")).toHaveTextContent(/\d+:\d{2}/);
    expect(screen.getByText(/第 2 局 · 进阶/)).toBeInTheDocument();
  });

  it("读秒阶段与局间用秒数表达", () => {
    const { unmount } = withProviders(<CEERankedScoreboard series={rankedSeries("countdown")} />);
    expect(screen.getByRole("timer")).toHaveTextContent("即将开始");
    expect(screen.getByRole("timer")).toHaveTextContent(/\ds/);
    unmount();

    withProviders(<CEERankedScoreboard series={rankedSeries("intermission")} />);
    expect(screen.getByRole("timer")).toHaveTextContent("下一局");
  });

  it("加时转警示口径，结算后不再显示时钟", () => {
    const { unmount } = withProviders(<CEERankedScoreboard series={rankedSeries("overtime")} />);
    const timer = screen.getByRole("timer");
    expect(timer).toHaveTextContent("加时");
    expect(timer.className).toContain("text-warning");
    unmount();

    withProviders(<CEERankedScoreboard series={rankedSeries("won")} />);
    expect(screen.queryByRole("timer")).not.toBeInTheDocument();
    expect(screen.getByText(/本场结束 · 进阶/)).toBeInTheDocument();
  });

  it("定级中的座位只写定级中，离线另有标记", () => {
    const series = rankedSeries("playing");
    withProviders(
      <CEERankedScoreboard
        series={{
          ...series,
          self: { ...series.self, rating: null, placementPlayed: 2 },
          opponent: { ...series.opponent, isBot: false, rating: 1588, online: false },
        }}
      />
    );

    expect(screen.getByText("定级中")).toBeInTheDocument();
    expect(screen.getByText("1588")).toBeInTheDocument();
    expect(screen.getByText("离线")).toBeInTheDocument();
  });
});

describe("CEERankedOpponentClues", () => {
  it("对手没出手时给空态", () => {
    withProviders(<CEERankedOpponentClues guesses={[]} attempts={0} allowance={10} />);

    expect(screen.getByText("对手还没有出手")).toBeInTheDocument();
    expect(screen.getByText("已猜 0 / 10")).toBeInTheDocument();
  });

  it("只画方向与命中数，不出现角色与数值", () => {
    const series = rankedSeries("playing");
    withProviders(
      <CEERankedOpponentClues
        guesses={series.game?.opponentGuesses ?? []}
        attempts={3}
        allowance={10}
      />
    );

    expect(screen.getByText("已猜 3 / 10")).toBeInTheDocument();
    expect(screen.getByText("#1")).toBeInTheDocument();
    expect(screen.getAllByLabelText(/^性别：/).length).toBeGreaterThan(0);
    expect(screen.getAllByLabelText(/^标签命中 \d+ \/ \d+$/).length).toBeGreaterThan(0);
    expect(screen.queryByText(/凉宫|伊地知/)).not.toBeInTheDocument();
  });

  it("猜中的一行带猜中标记", () => {
    const series = rankedSeries("playing");
    const guesses = series.game?.opponentGuesses ?? [];
    withProviders(
      <CEERankedOpponentClues
        guesses={[...guesses, { ...guesses[0], index: 9, correct: true }]}
        attempts={4}
        allowance={10}
      />
    );

    expect(screen.getByText("猜中")).toBeInTheDocument();
  });
});

describe("CEERankedGameRecap", () => {
  it("展示答案、标题与双方完整猜测", () => {
    const game = rankedSeries("won").games[0];
    withProviders(<CEERankedGameRecap game={game} />);

    expect(screen.getByRole("heading", { name: "第 1 局 · 对手先猜中了" })).toBeInTheDocument();
    expect(screen.getByText(/你的猜测 · 3 次/)).toBeInTheDocument();
    expect(screen.getByText(/对手的猜测 · 3 次/)).toBeInTheDocument();
    expect(screen.getAllByLabelText("猜中").length).toBeGreaterThan(0);
  });

  it("一方没出手时写没有出手", () => {
    const game = { ...rankedSeries("won").games[0], opponentGuesses: [] };
    withProviders(<CEERankedGameRecap game={game} />);

    expect(screen.getByText("没有出手")).toBeInTheDocument();
  });
});

describe("CEERankedResultCard", () => {
  const props = { placementTotal: 5, onRequeue: vi.fn(), onLeave: vi.fn() };

  it("胜利给出结算分与分差，两个出口都能点", async () => {
    const onRequeue = vi.fn();
    const onLeave = vi.fn();
    withProviders(
      <CEERankedResultCard
        {...props}
        onRequeue={onRequeue}
        onLeave={onLeave}
        series={rankedSeries("won")}
      />
    );

    expect(screen.getByRole("heading", { name: "胜利" })).toBeInTheDocument();
    expect(screen.getByText(/三局两胜/)).toBeInTheDocument();
    expect(screen.getByText("+15")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "再来一场" }));
    await userEvent.click(screen.getByRole("button", { name: "返回" }));
    expect(onRequeue).toHaveBeenCalledOnce();
    expect(onLeave).toHaveBeenCalledOnce();
  });

  it("失利与平局各自成句", () => {
    const { unmount } = withProviders(
      <CEERankedResultCard {...props} series={rankedSeries("lost")} />
    );
    expect(screen.getByRole("heading", { name: "惜败" })).toBeInTheDocument();
    expect(screen.getByText("-13")).toBeInTheDocument();
    unmount();

    withProviders(<CEERankedResultCard {...props} series={rankedSeries("drawn")} />);
    expect(screen.getByRole("heading", { name: "平局" })).toBeInTheDocument();
    expect(screen.getByText(/三局打完，比分持平/)).toBeInTheDocument();
  });

  it("退出与掉线按胜负给出不同说明", () => {
    const won = rankedSeries("won");
    const { unmount } = withProviders(
      <CEERankedResultCard
        {...props}
        series={{
          ...won,
          result: { ...won.result!, reason: "exit" },
        }}
      />
    );
    expect(screen.getByText(/对手退出了比赛/)).toBeInTheDocument();
    unmount();

    const lost = rankedSeries("lost");
    withProviders(
      <CEERankedResultCard
        {...props}
        series={{ ...lost, result: { ...lost.result!, reason: "offline" } }}
      />
    );
    expect(screen.getByText(/你掉线超时/)).toBeInTheDocument();
  });

  it("结算未落定时禁掉再来一场", () => {
    withProviders(<CEERankedResultCard {...props} series={rankedSeries("pending")} />);

    expect(screen.getByText("正在结算…")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "再来一场" })).toBeDisabled();
  });

  it("不计分与结算失败各有一句说明", () => {
    const { unmount } = withProviders(
      <CEERankedResultCard {...props} series={rankedSeries("failed")} />
    );
    expect(screen.getByText("结算没能保存，本场不计分")).toBeInTheDocument();
    unmount();

    withProviders(<CEERankedResultCard {...props} series={rankedSeries("unrated")} />);
    expect(screen.getByText("今日人机计分局已用完，本场不计分")).toBeInTheDocument();
  });

  it("定级过程只给进度，定级完成亮出分数", () => {
    const { unmount } = withProviders(
      <CEERankedResultCard {...props} series={rankedSeries("placementProgress")} />
    );
    expect(screen.getByText("定级赛 3 / 5")).toBeInTheDocument();
    unmount();

    withProviders(<CEERankedResultCard {...props} series={rankedSeries("placementDone")} />);
    expect(screen.getByText("定级完成")).toBeInTheDocument();
    expect(screen.getByText("1612")).toBeInTheDocument();
  });
});

describe("CEERankedMatch", () => {
  const props = {
    pending: {},
    onGuess: vi.fn().mockResolvedValue(true),
    onSurrender: vi.fn(),
    onExit: vi.fn(),
  };

  it("读秒阶段只给局号与倒计时", () => {
    withProviders(<CEERankedMatch {...props} series={rankedSeries("countdown")} />);

    expect(screen.getByRole("status")).toHaveTextContent("第 1 局即将开始");
    expect(screen.getByText("双方猜同一个角色，先猜中者得分")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /认输本局/ })).not.toBeInTheDocument();
  });

  it("对局中给出搜索、认输与反馈表", () => {
    withProviders(<CEERankedMatch {...props} series={rankedSeries("playing")} />);

    expect(screen.getByRole("button", { name: /认输本局/ })).toBeEnabled();
    expect(screen.getByRole("region", { name: "你的猜测" })).toBeInTheDocument();
    expect(screen.getByRole("region", { name: "对手的线索" })).toBeInTheDocument();
  });

  it("加时公开的提示落在横幅里", () => {
    withProviders(<CEERankedMatch {...props} series={rankedSeries("overtime")} />);

    expect(screen.getByText(/加时提示：/)).toBeInTheDocument();
    expect(screen.getByText(/乐队里负责贝斯/)).toBeInTheDocument();
  });

  it("次数用完时提示等待对手或加时", () => {
    const series = rankedSeries("playing");
    withProviders(
      <CEERankedMatch {...props} series={{ ...series, self: { ...series.self, finished: true } }} />
    );

    expect(screen.getByText("你的次数已用完，等对手出手或等待加时")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /认输本局/ })).toBeDisabled();
  });

  it("退出整场要二次确认，且不会误触退出", async () => {
    const onExit = vi.fn();
    withProviders(<CEERankedMatch {...props} onExit={onExit} series={rankedSeries("playing")} />);

    await userEvent.click(screen.getByRole("button", { name: /退出这场/ }));
    const dialog = await screen.findByRole("dialog");
    expect(dialog).toHaveTextContent("退出即判负整场");
    expect(onExit).not.toHaveBeenCalled();

    await userEvent.click(within(dialog).getByRole("button", { name: "退出并判负" }));
    expect(onExit).toHaveBeenCalledOnce();
  });

  it("认输只放弃本局，交给上层提交", async () => {
    const onSurrender = vi.fn();
    withProviders(
      <CEERankedMatch {...props} onSurrender={onSurrender} series={rankedSeries("playing")} />
    );

    await userEvent.click(screen.getByRole("button", { name: /认输本局/ }));
    expect(onSurrender).toHaveBeenCalledOnce();
  });
});
