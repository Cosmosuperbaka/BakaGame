import { act, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { rankedSeries } from "@/stories/fixtures/CEERanked";
import { ratingReveal, revealCard } from "@/lib/Motion";
import { CEERankedResultCard } from "./CEERankedResultCard";

const renderCard = () =>
  render(
    <CEERankedResultCard
      series={rankedSeries("won")}
      placementTotal={5}
      onRequeue={vi.fn()}
      onLeave={vi.fn()}
    />
  );

/** 徽章外层的可见度：动画起点写在行内样式上，未起播时就是 0。 */
const badgeOpacity = () => {
  const badge = screen.getByText(/^\+\d+$/);
  return Number(getComputedStyle(badge.parentElement as HTMLElement).opacity);
};

describe("CEERankedResultCard 的分数变化徽章", () => {
  it("揭晓时先不亮出加分，等分数滚到位才盖上去", async () => {
    renderCard();
    expect(badgeOpacity()).toBe(0);
    // 卡片刚放稳、分数才开始滚的时刻，徽章仍未出现。
    await act(() => new Promise((resolve) => setTimeout(resolve, revealCard.settle * 1000)));
    expect(badgeOpacity()).toBe(0);
  });

  it("徽章的出场时刻晚于卡片放稳（分数开始滚动）", () => {
    expect(ratingReveal.transition.delay).toBeGreaterThan(revealCard.settle);
  });
});
