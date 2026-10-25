import {
  useLayoutEffect,
  useRef,
  type KeyboardEvent,
  type MouseEvent,
  type RefObject,
} from "react";
import type { SongLyricLine } from "@bakagame/shared";
import { cn } from "@/lib/Utils";
import { SongClipLyricScene } from "./SongClipLyricScene";

export interface SongClipLyricSelectorProps {
  lines: SongLyricLine[];
  range: readonly [number, number];
  anchorIndex: number | null;
  onPick: (index: number) => void;
  audioRef?: RefObject<HTMLAudioElement | null>;
  playing?: boolean;
  listRef?: RefObject<HTMLDivElement | null>;
  className?: string;
}

function eventLine(target: EventTarget | null, host: HTMLElement) {
  if (!(target instanceof Element)) return null;
  const line = target.closest<HTMLElement>("[data-line-index]");
  return line && host.contains(line) ? line : null;
}

export function SongClipLyricSelector({
  lines,
  range,
  anchorIndex,
  onPick,
  audioRef,
  playing = false,
  listRef,
  className,
}: SongClipLyricSelectorProps) {
  const hostRef = useRef<HTMLDivElement>(null);
  const sceneRef = useRef<SongClipLyricScene | null>(null);

  useLayoutEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    const scene = new SongClipLyricScene(host);
    sceneRef.current = scene;
    return () => {
      scene.dispose();
      sceneRef.current = null;
    };
  }, []);

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

  const empty = lines.length === 0;
  return (
    <div
      ref={listRef}
      className={cn(
        "max-h-72 overflow-y-auto overscroll-contain rounded-md bg-background p-1.5 sm:max-h-80",
        className
      )}
    >
      {empty ? (
        <p className="flex h-24 items-center justify-center px-3 text-center text-sm text-muted-foreground sm:h-28">
          纯音乐或无歌词，拖动上方时间轴选择片段。
        </p>
      ) : null}
      <div
        ref={hostRef}
        hidden={empty}
        role="group"
        aria-label="歌词选取"
        className="baka-lyric-host baka-clip-lyric-host"
        data-testid="song-clip-lyric-selector"
        onClick={onClick}
        onKeyDown={onKeyDown}
      />
    </div>
  );
}
