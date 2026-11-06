import {
  useLayoutEffect,
  useRef,
  useState,
  type FocusEvent,
  type KeyboardEvent,
  type MouseEvent,
  type RefObject,
} from "react";
import { AnimatePresence, motion } from "framer-motion";
import { ArrowDown, ArrowUp, Music2 } from "lucide-react";
import type { SongLyricLine } from "@bakagame/shared";
import { Button } from "@/components/ui/Button";
import { readoutSwap } from "@/lib/Motion";
import { cn } from "@/lib/Utils";
import { SongClipLyricScene, type SelectionPlacement } from "./SongClipLyricScene";

export interface SongClipLyricSheetProps {
  lines: SongLyricLine[];
  range: readonly [number, number];
  anchorIndex: number | null;
  onPick: (index: number) => void;
  /** Esc 取消已点的那一句。 */
  onClearAnchor?: () => void;
  audioRef?: RefObject<HTMLAudioElement | null>;
  playing?: boolean;
  className?: string;
}

function eventLine(target: EventTarget | null, host: HTMLElement) {
  if (!(target instanceof Element)) return null;
  const line = target.closest<HTMLElement>("[data-line-index]");
  return line && host.contains(line) ? line : null;
}

const ROW_KEYS = {
  ArrowDown: "next",
  ArrowUp: "previous",
  Home: "first",
  End: "last",
} as const;

/**
 * 静止的逐字歌词选取页：AMLL 只负责逐字遮罩与排版测量，行盒留在文档流里。
 * 普通行按原始 `words` 判定，不借用转换层的整行兜底词。
 * 整张列表只占一个 Tab 停靠点，方向键在行间移动。
 */
export function SongClipLyricSheet({
  lines,
  range,
  anchorIndex,
  onPick,
  onClearAnchor,
  audioRef,
  playing = false,
  className,
}: SongClipLyricSheetProps) {
  const hostRef = useRef<HTMLDivElement>(null);
  const sceneRef = useRef<SongClipLyricScene | null>(null);
  const [placement, setPlacement] = useState<SelectionPlacement>(null);
  const empty = lines.length === 0;

  useLayoutEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    const scene = new SongClipLyricScene(host);
    sceneRef.current = scene;
    scene.onPlacement = setPlacement;
    return () => {
      scene.onPlacement = undefined;
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
  const onFocus = (event: FocusEvent<HTMLDivElement>) => {
    const line = eventLine(event.target, event.currentTarget);
    if (line) sceneRef.current?.setRovingRow(Number(line.dataset.lineIndex));
  };
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const line = eventLine(event.target, event.currentTarget);
    if (!line) return;
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      pick(line);
      return;
    }
    if (event.key === "Escape" && anchorIndex !== null) {
      event.stopPropagation();
      onClearAnchor?.();
      return;
    }
    const move = ROW_KEYS[event.key as keyof typeof ROW_KEYS];
    if (!move) return;
    event.preventDefault();
    sceneRef.current?.focusRow(move, Number(line.dataset.lineIndex));
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
        <>
          <div className="baka-clip-lyric-scroller" data-testid="song-clip-lyric-scroll">
            <div
              ref={hostRef}
              role="group"
              aria-label="歌词选取"
              className="baka-lyric-host baka-clip-lyric-host"
              data-testid="song-clip-lyric-sheet"
              onClick={onClick}
              onFocus={onFocus}
              onKeyDown={onKeyDown}
            />
            <div aria-hidden="true" className="h-3" />
          </div>
          <AnimatePresence initial={false}>
            {placement ? (
              <motion.div
                key="back-to-selection"
                variants={readoutSwap}
                initial="initial"
                animate="animate"
                exit="exit"
                className={cn(
                  "absolute right-3 z-panel",
                  placement === "above" ? "top-2" : "bottom-2"
                )}
              >
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={() => sceneRef.current?.revealSelection()}
                  data-agent-control="song.clip.reveal"
                >
                  {placement === "above" ? (
                    <ArrowUp aria-hidden="true" />
                  ) : (
                    <ArrowDown aria-hidden="true" />
                  )}
                  回到选段
                </Button>
              </motion.div>
            ) : null}
          </AnimatePresence>
        </>
      )}
    </div>
  );
}
