import { render, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { CCBCharacterView } from "@bakagame/shared";
import { ccbWs } from "@/lib/CCBWs";
import { CCBAnswerCard } from "./CCBAnswerCard";

/** jsdom 没有 IntersectionObserver：这里把「被观察」直接当成已滚进视口。 */
class ImmediateObserver {
  constructor(private readonly callback: IntersectionObserverCallback) {}
  observe(target: Element): void {
    this.callback([{ isIntersecting: true, target } as IntersectionObserverEntry], this as unknown as IntersectionObserver);
  }
  unobserve(): void {}
  disconnect(): void {}
  takeRecords(): IntersectionObserverEntry[] { return []; }
}

const GRID = "https://mirror.example.test/pic/crt/g/1.jpg";
const LARGE = "https://mirror.example.test/r/400/pic/crt/l/1.jpg";

const answer: CCBCharacterView = {
  id: 1, name: "Nijika", nameCn: "虹夏", gender: "female", popularity: 0, summary: "",
  imageUrl: GRID,
  appearances: [], highestRating: -1, earliestAppearance: 0, latestAppearance: 0,
  subjectTags: [], characterTags: [], voiceActors: [], metaTags: [], comparisonAppearances: [], extraTags: [],
};

describe("CCB 答案卡", () => {
  afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

  it("结算答案卡用大图：方格图先撑住版式，大图回来后替换", async () => {
    vi.stubGlobal("IntersectionObserver", ImmediateObserver);
    const send = vi.spyOn(ccbWs, "send").mockResolvedValue({ imageUrl: LARGE } as never);
    const { container } = render(<CCBAnswerCard answer={answer} />);
    const image = () => container.querySelector("img");
    // 快照里带的是方格图：先用它顶上，不闪占位图标。
    expect(image()?.getAttribute("src")).toBe(GRID);
    await waitFor(() => expect(image()?.getAttribute("src")).toBe(LARGE));
    expect(send).toHaveBeenCalledWith("ccb.character.image", { characterId: 1, size: "large" }, expect.anything());
  });
});
