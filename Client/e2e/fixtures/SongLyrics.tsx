import { LyricPlayer } from "@applemusic-like-lyrics/core";
import { StrictMode, createRef } from "react";
import { createRoot } from "react-dom/client";
import { flushSync } from "react-dom";
import {
  SongLyricPlayer,
  type SongLyricPlayerProps,
} from "@/components/songuessr/lyrics/SongLyricPlayer";
import {
  SongClipLyricSelector,
  type SongClipLyricSelectorProps,
} from "@/components/songuessr/SongClipLyricSelector";
import "@applemusic-like-lyrics/core/style.css";
import "@/index.css";

// 浏览器桥接只接受可序列化属性；audioRef 始终由夹具持有，不能跨 page.evaluate 传递。
export type SongLyricsFixtureProps = Partial<Omit<SongLyricPlayerProps, "audioRef">>;
export type SongClipSelectorFixtureProps = Partial<
  Omit<SongClipLyricSelectorProps, "audioRef" | "onPick" | "listRef">
>;

// 仅计数，不替代 AMLL 实现；比较实际动画更新次数，不能据此推断 CPU 占用。
let updates = 0;
const nativeUpdate = LyricPlayer.prototype.update;
LyricPlayer.prototype.update = function (delta) {
  updates++;
  return nativeUpdate.call(this, delta);
};

const root = createRoot(document.getElementById("root")!);
const audio = document.createElement("audio");
const audioRef = createRef<HTMLAudioElement>();
audioRef.current = audio;
let mode: "player" | "selector" = "player";
let props: SongLyricPlayerProps = { lines: [], audioRef };
let selectorProps: SongClipLyricSelectorProps = {
  lines: [],
  range: [0, 0],
  anchorIndex: null,
  onPick: () => {},
};
const picks: number[] = [];

function renderRoot() {
  flushSync(() =>
    root.render(
      <StrictMode>
        <main style={{ width: "min(100% - 32px, 760px)", margin: "32px auto" }}>
          {mode === "selector" ? (
            <SongClipLyricSelector {...selectorProps} audioRef={audioRef} onPick={onPick} />
          ) : (
            <SongLyricPlayer {...props} />
          )}
        </main>
      </StrictMode>
    )
  );
}

function onPick(index: number) {
  picks.push(index);
}

// 只替代媒体解码和房间传输；React、AMLL、字体和浏览器布局均使用生产实现。
Object.assign(window, {
  lyricsFixture: {
    updates: () => updates,
    picks: () => [...picks],
    render(update: SongLyricsFixtureProps) {
      mode = "player";
      props = { ...props, ...update };
      renderRoot();
    },
    renderSelector(update: SongClipSelectorFixtureProps) {
      mode = "selector";
      selectorProps = { ...selectorProps, ...update };
      renderRoot();
    },
    time(ms: number, playing: boolean) {
      audio.currentTime = ms / 1000;
      Object.defineProperty(audio, "paused", { configurable: true, value: !playing });
      audio.dispatchEvent(new Event(playing ? "play" : "pause"));
      audio.dispatchEvent(new Event("timeupdate"));
    },
  },
});
