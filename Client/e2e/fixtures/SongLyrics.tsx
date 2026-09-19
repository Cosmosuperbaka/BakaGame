import { StrictMode, createRef } from "react";
import { createRoot } from "react-dom/client";
import { flushSync } from "react-dom";
import { SongLyricPlayer, type SongLyricPlayerProps } from "@/components/songuessr/lyrics/SongLyricPlayer";
import "@applemusic-like-lyrics/core/style.css";
import "@/index.css";

const root = createRoot(document.getElementById("root")!);
const audio = document.createElement("audio");
const audioRef = createRef<HTMLAudioElement>();
audioRef.current = audio;
let props: SongLyricPlayerProps = { lines: [], audioRef };

// 只替代媒体解码和房间传输；React、AMLL、字体和浏览器布局均使用生产实现。
Object.assign(window, {
  lyricsFixture: {
    render(update: Partial<SongLyricPlayerProps>) {
      props = { ...props, ...update };
      flushSync(() => root.render(
        <StrictMode><main style={{ width: "min(100% - 32px, 760px)", margin: "32px auto" }}>
          <SongLyricPlayer {...props} />
        </main></StrictMode>,
      ));
    },
    time(ms: number, playing: boolean) {
      audio.currentTime = ms / 1000;
      Object.defineProperty(audio, "paused", { configurable: true, value: !playing });
      audio.dispatchEvent(new Event(playing ? "play" : "pause"));
      audio.dispatchEvent(new Event("timeupdate"));
    },
  },
});
