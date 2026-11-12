import { act, renderHook } from "@testing-library/react";
import { expect, it, vi } from "vitest";
import { useClipPreviewAudio } from "./UseClipPreviewAudio";

const setup = () =>
  renderHook(({ range }) => useClipPreviewAudio({ range, volume: 0.5 }), {
    initialProps: { range: [1_000, 5_000] as readonly [number, number] },
  });

it("音频元素晚于 hook 挂载才出现时，卸载仍会停掉播放", () => {
  const audio = document.createElement("audio");
  const pause = vi.spyOn(audio, "pause").mockImplementation(() => {});
  const { result, rerender, unmount } = setup();
  // 挂载时还没有元素；之后元素才渲染出来
  result.current.audioRef.current = audio;
  rerender({ range: [1_000, 5_000] });
  pause.mockClear();
  unmount();
  expect(pause).toHaveBeenCalled();
});

it("重新开始加载（换了音源）时，失败提示复位", () => {
  const { result } = setup();
  act(() => result.current.audioEvents.onError());
  expect(result.current.failed).toBe(true);
  act(() => result.current.audioEvents.onLoadStart());
  expect(result.current.failed).toBe(false);
});
