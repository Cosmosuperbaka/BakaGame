import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { LazyImage } from "./LazyImage";

/** 手动触发「滚进视口」的观察器替身。 */
let intersect: () => void = () => {};
class FakeObserver {
  constructor(callback: IntersectionObserverCallback) {
    intersect = () =>
      callback([{ isIntersecting: true } as IntersectionObserverEntry], this as never);
  }
  observe() {}
  disconnect() {}
  unobserve() {}
}

afterEach(() => vi.unstubAllGlobals());

describe("LazyImage 加载失败态", () => {
  it("缩略图加载失败显示占位，清晰图取回后重新显示图片，不被旧的失败钉死", async () => {
    vi.stubGlobal("IntersectionObserver", FakeObserver);
    const request = vi.fn().mockResolvedValue("/hd.png");
    const { container } = render(
      <LazyImage
        cacheKey="lazy-image-upgrade"
        initial="/thumb.png"
        upgrade
        request={request}
        fallback={<span>占位</span>}
      />
    );
    fireEvent.error(container.querySelector("img")!);
    expect(screen.getByText("占位")).toBeInTheDocument();

    act(() => intersect());
    await waitFor(() => expect(container.querySelector("img")).toHaveAttribute("src", "/hd.png"));
    expect(screen.queryByText("占位")).not.toBeInTheDocument();
  });

  it("同一个地址失败后仍显示占位，不无限重试", () => {
    vi.stubGlobal("IntersectionObserver", FakeObserver);
    const { container } = render(
      <LazyImage
        cacheKey="lazy-image-same"
        initial="/broken.png"
        request={vi.fn()}
        fallback={<span>占位</span>}
      />
    );
    fireEvent.error(container.querySelector("img")!);
    expect(screen.getByText("占位")).toBeInTheDocument();
    expect(container.querySelector("img")).toBeNull();
  });
});
