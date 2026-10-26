import {
  useLayoutEffect,
  useRef,
  type KeyboardEvent,
  type MouseEvent,
  type RefObject,
} from "react";
import { Music2 } from "lucide-react";
import type { SongLyricLine } from "@bakagame/shared";
import { cn } from "@/lib/Utils";
import { SongClipLyricScene } from "./SongClipLyricScene";

export interface SongClipLyricSheetProps {
  lines: SongLyricLine[];
  range: readonly [number, number];
  anchorIndex: number | null;
  onPick: (index: number) => void;
  audioRef?: RefObject<HTMLAudioElement | null>;
  playing?: boolean;
  className?: string;
}

function eventLine(target: EventTarget | null, host: HTMLElement) {
  if (!(target instanceof Element)) return null;
  const line = target.closest<HTMLElement>("[data-line-index]");
  return line && host.contains(line) ? line : null;
}

/**
 * 静止的逐字歌词选取页：AMLL 只负责逐字遮罩与排版测量，行盒留在文档流里。
 * 普通行按原始 `words` 判定，不借用转换层的整行兜底词。
 */
export function SongClipLyricSheet({
  lines,
  range,
  anchorIndex,
  onPick,
  audioRef,
  playing = false,
  className,
}: SongClipLyricSheetProps) {
  const hostRef = useRef<HTMLDivElement>(null);
  const scrollerRef = useRef<HTMLDivElement>(null);
  const sceneRef = useRef<SongClipLyricScene | null>(null);
  const positionedRef = useRef(false);
  const empty = lines.length === 0;

  useLayoutEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    const scene = new SongClipLyricScene(host);
    sceneRef.current = scene;
    scene.onReady = () => {
      if (positionedRef.current) return;
      positionedRef.current = true;
      const scroller = scrollerRef.current;
      const firstSelected = host.querySelector<HTMLElement>('[data-selected="true"]');
      if (!scroller || !firstSelected) return;
      const offset =
        firstSelected.getBoundingClientRect().top - scroller.getBoundingClientRect().top;
      scroller.scrollTop = Math.max(0, scroller.scrollTop + offset - 12);
    };
    return () => {
      scene.onReady = undefined;
      scene.dispose();
      sceneRef.current = null;
    };
  }, [empty]);

  useLayoutEffect(() => {
    sceneRef.current?.setSource(lines, audioRef?.current ?? null);
  }, [lines, audioRef]);

  useLayoutEffect(() => {
    sceneRef.current?.setPlayback(playing);
  }, [playing]);

  useLayoutEffect(() => {
    sceneRef.current?.setSelection(range, anchorIndex);
  }, [range, anchorIndex]);

  const pick = (line: HTMLElement | null) => {
    if (!line) return;
    const index = Number(line.dataset.lineIndex);
    if (Number.isInteger(index)) onPick(index);
  };
  const onClick = (event: MouseEvent<HTMLDivElement>) => {
    pick(eventLine(event.target, event.currentTarget));
  };
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key !== "Enter" && event.key !== " ") return;
    const line = eventLine(event.target, event.currentTarget);
    if (!line) return;
    event.preventDefault();
    pick(line);
  };

  return (
    <div className={cn("relative", className)}>
      {empty ? (
        <div
          role="status"
          className="flex h-44 flex-col items-center justify-center gap-2 px-6 text-center"
        >
          <span className="flex size-10 items-center justify-center rounded-full bg-muted text-muted-foreground">
            <Music2 className="size-4" aria-hidden="true" />
          </span>
          <p className="text-sm text-muted-foreground">纯音乐，没有可选的歌词</p>
          <p className="text-2xs text-muted-foreground">拖动上方截取条，或用键盘微调起止时间。</p>
        </div>
      ) : (
        <div
          ref={scrollerRef}
          className="baka-clip-lyric-scroller h-72 overflow-y-auto overscroll-contain sm:h-80"
          data-testid="song-clip-lyric-scroll"
        >
          <div
            ref={hostRef}
            role="group"
            aria-label="歌词选取"
            className="baka-lyric-host baka-clip-lyric-host px-1 py-1 sm:px-2"
            data-testid="song-clip-lyric-sheet"
            onClick={onClick}
            onKeyDown={onKeyDown}
          />
          <div aria-hidden="true" className="h-3" />
        </div>
      )}
    </div>
  );
}
