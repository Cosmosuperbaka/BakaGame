import { render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { CEECharacterView } from "@bakagame/shared";
import { ceeWsClient } from "@/lib/CEEWs";
import { CEEAnswerCard } from "./CEEAnswerCard";

/** jsdom 没有 IntersectionObserver：这里把「被观察」直接当成已滚进视口。 */
class ImmediateObserver {
  private readonly callback: IntersectionObserverCallback;
  constructor(callback: IntersectionObserverCallback) {
    this.callback = callback;
  }
  observe(target: Element): void {
    this.callback(
      [{ isIntersecting: true, target } as IntersectionObserverEntry],
      this as unknown as IntersectionObserver
    );
  }
  unobserve(): void {}
  disconnect(): void {}
  takeRecords(): IntersectionObserverEntry[] {
    return [];
  }
}

const GRID = "https://mirror.example.test/pic/crt/g/1.jpg";
const LARGE = "https://mirror.example.test/r/400/pic/crt/l/1.jpg";

const answer: CEECharacterView = {
  id: 1,
  name: "Nijika",
  nameCn: "虹夏",
  gender: "female",
  popularity: 0,
  summary: "",
  imageUrl: GRID,
  appearances: [],
  highestRating: -1,
  earliestAppearance: 0,
  latestAppearance: 0,
  subjectTags: [],
  characterTags: [],
  voiceActors: [],
  metaTags: [],
  comparisonAppearances: [],
  extraTags: [],
};

describe("CEE 答案卡", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("结算答案卡用大图：方格图先撑住版式，大图回来后替换", async () => {
    vi.stubGlobal("IntersectionObserver", ImmediateObserver);
    const send = vi.spyOn(ceeWsClient, "send").mockResolvedValue({ imageUrl: LARGE } as never);
    const { container } = render(<CEEAnswerCard answer={answer} />);
    const image = () => container.querySelector("img");
    // 快照里带的是方格图：先用它顶上，不闪占位图标。
    expect(image()?.getAttribute("src")).toBe(GRID);
    await waitFor(() => expect(image()?.getAttribute("src")).toBe(LARGE));
    expect(send).toHaveBeenCalledWith(
      "cee.character.image",
      { characterId: 1, size: "large" },
      expect.anything()
    );
  });

  it("简介是资料表的一行：与作品、声优同一张表，正文直接可读，不藏在折叠标题后面", () => {
    vi.stubGlobal("IntersectionObserver", ImmediateObserver);
    vi.spyOn(ceeWsClient, "send").mockResolvedValue({ imageUrl: LARGE } as never);
    render(
      <CEEAnswerCard
        answer={{ ...answer, voiceActors: ["铃代纱弓"], summary: "结束乐队的鼓手兼队长。" }}
      />
    );
    const term = screen.getByText("简介");
    expect(term.tagName).toBe("DT");
    expect(term.closest("dl")).toContainElement(screen.getByText("声优"));
    expect(term.closest("dl")).toContainElement(screen.getByText("结束乐队的鼓手兼队长。"));
    expect(screen.queryByRole("button", { name: "角色简介" })).not.toBeInTheDocument();
  });

  it("没有作品、声优与简介时不渲染资料表", () => {
    vi.stubGlobal("IntersectionObserver", ImmediateObserver);
    vi.spyOn(ceeWsClient, "send").mockResolvedValue({ imageUrl: LARGE } as never);
    render(<CEEAnswerCard answer={answer} />);
    expect(screen.queryByText("作品")).not.toBeInTheDocument();
    expect(screen.queryByText("简介")).not.toBeInTheDocument();
  });
});
