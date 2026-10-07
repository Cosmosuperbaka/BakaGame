import { useEffect, useRef, useState, type KeyboardEvent } from "react";
import { AnimatePresence, motion } from "framer-motion";
import * as Popover from "@radix-ui/react-popover";
import { Volume, Volume1, Volume2, VolumeX } from "lucide-react";
import type { LucideIcon } from "lucide-react";
import { FollowNumber } from "@/components/ui/FollowNumber";
import { Button } from "@/components/ui/Button";
import { Slider } from "@/components/ui/Slider";
import { useCloseFrom } from "@/hooks/UseCloseFrom";
import { iconTappable, popover, readoutSwap } from "@/lib/Motion";
import { cn } from "@/lib/Utils";

export interface VolumeControlProps {
  volume: number;
  onVolumeChange: (value: number) => void;
}

/** 从静音恢复时没有记过可听的音量（进房时就是 0）就回到默认音量，与 `useAudioClipPlayer` 的缺省一致。 */
const FALLBACK_VOLUME = 0.65;

/** 图标随音量分档：静音、低、中、高，形状本身读得出大小，不靠颜色。 */
function volumeIcon(volume: number): { key: string; icon: LucideIcon } {
  if (volume === 0) return { key: "muted", icon: VolumeX };
  if (volume < 0.34) return { key: "low", icon: Volume };
  if (volume < 0.67) return { key: "mid", icon: Volume1 };
  return { key: "high", icon: Volume2 };
}

/**
 * 记住最近一次可听的音量：点图标静音再点一次恢复到它，拖到 0 也算静音。
 * 只在本组件内记，刷新后从存档的音量重新开始。
 */
function useMuteToggle(volume: number, onVolumeChange: (value: number) => void) {
  const audible = useRef(volume > 0 ? volume : FALLBACK_VOLUME);
  useEffect(() => {
    if (volume > 0) audible.current = volume;
  }, [volume]);
  return () => onVolumeChange(volume > 0 ? 0 : audible.current);
}

/**
 * 房间顶栏的播放音量：图标加细轨道的胶囊。点图标静音 / 恢复；悬停或聚焦时轨道变粗、滑块显出，读数随值逐位滚动。
 * `sm` 起常驻；更窄时收成图标按钮、点开弹出同一个胶囊，把中栏让给轮数与视角徽章。
 */
export function VolumeControl({ volume, onVolumeChange }: VolumeControlProps) {
  const [open, setOpen] = useState(false);
  useCloseFrom(open, setOpen, "sm");
  const toggleMute = useMuteToggle(volume, onVolumeChange);
  const title = volume === 0 ? "已静音" : `播放音量 ${Math.round(volume * 100)}%`;

  return (
    <>
      <VolumeCapsule volume={volume} onVolumeChange={onVolumeChange} onToggleMute={toggleMute} className="hidden sm:flex" title={title} />
      <Popover.Root open={open} onOpenChange={setOpen}>
        <Popover.Trigger asChild>
          <Button type="button" variant="ghost" size="icon" className="sm:hidden" aria-label="调节音量" title={title}>
            <VolumeGlyph volume={volume} className="h-5 w-5" />
          </Button>
        </Popover.Trigger>
        {/* 受控 + forceMount：关闭时经 AnimatePresence 播完退场再卸载，与玩家行浮层同口径。 */}
        <AnimatePresence>
          {open ? (
            <Popover.Portal forceMount>
              <Popover.Content forceMount side="bottom" align="end" sideOffset={6} collisionPadding={12} aria-label="播放音量" asChild>
                <motion.div
                  variants={popover}
                  initial="initial"
                  animate="animate"
                  exit="exit"
                  // 胶囊浮层：floating-surface 自带 rounded-md，这里显式压成全圆角。
                  className="z-popover origin-(--radix-popover-content-transform-origin) floating-surface !rounded-full p-1 shadow-md"
                >
                  {/* 触屏没有悬停：弹出层里轨道始终是粗的那一档，整行高度都能按住拖动。 */}
                  <VolumeCapsule volume={volume} onVolumeChange={onVolumeChange} onToggleMute={toggleMute} expanded className="flex border-0 bg-transparent shadow-none" />
                </motion.div>
              </Popover.Content>
            </Popover.Portal>
          ) : null}
        </AnimatePresence>
      </Popover.Root>
    </>
  );
}

/** 图标在分档之间交叉替换：旧的淡出、新的自下方顶上来，与读数同一个 `readoutSwap`。 */
function VolumeGlyph({ volume, className }: { volume: number; className: string }) {
  const { key, icon: Icon } = volumeIcon(volume);
  return (
    <span className={cn("relative inline-grid place-items-center", className)} aria-hidden="true">
      <AnimatePresence initial={false} mode="popLayout">
        <motion.span key={key} variants={readoutSwap} initial="initial" animate="animate" exit="exit" className="col-start-1 row-start-1">
          <Icon className={className} />
        </motion.span>
      </AnimatePresence>
    </span>
  );
}

interface VolumeCapsuleProps extends VolumeControlProps {
  onToggleMute: () => void;
  /** 始终取粗轨道、显出滑块（触屏弹出层） */
  expanded?: boolean;
  className?: string;
  title?: string;
}

/**
 * 胶囊本体：静音按钮、轨道与百分比读数，常驻音量条与弹出层共用。
 * 轨道细时只有 4px，滑块收起；悬停或键盘聚焦到滑块时轨道补间到 6px、滑块弹出，与 Switch 同一档 `spring.snap` 的 CSS 弹性。
 * 根节点撑满胶囊高度，整条都能按住拖动，不必对准细轨道。
 */
function VolumeCapsule({ volume, onVolumeChange, onToggleMute, expanded = false, className, title }: VolumeCapsuleProps) {
  const percentage = Math.round(volume * 100);
  const muted = volume === 0;
  const spring = "duration-(--motion-spring-snap-duration) ease-(--motion-spring-snap)";
  return (
    <div
      title={title}
      data-expanded={expanded || undefined}
      className={cn("group/volume h-9 items-center gap-1 rounded-full border bg-panel pr-2 pl-1 shadow-sm", className)}
    >
      <motion.button
        type="button"
        {...iconTappable}
        onClick={onToggleMute}
        aria-label={muted ? "取消静音" : "静音"}
        aria-pressed={muted}
        className={cn(
          "flex h-7 w-7 shrink-0 items-center justify-center rounded-full transition-colors hover:bg-accent",
          muted ? "text-muted-foreground" : "text-foreground",
        )}
      >
        <VolumeGlyph volume={volume} className="h-4 w-4" />
      </motion.button>
      <Slider
        className="h-full w-28"
        trackClassName={cn(
          "h-1 transition-[height]", spring,
          "group-hover/volume:h-1.5 group-focus-within/volume:h-1.5 group-data-expanded/volume:h-1.5",
        )}
        thumbClassName={cn(
          // 收起时缩到一半并透明，而不是缩成 0：包围盒仍在，自动化与读屏按可见元素找得到滑块。
          "scale-50 opacity-0 transition-[scale,opacity,background-color]", spring,
          "group-hover/volume:scale-100 group-hover/volume:opacity-100 group-focus-within/volume:scale-100 group-focus-within/volume:opacity-100",
          "group-data-expanded/volume:scale-100 group-data-expanded/volume:opacity-100",
        )}
        value={[volume]}
        min={0}
        max={1}
        step={0.01}
        onValueChange={([value]) => onVolumeChange(value)}
        aria-label="播放音量"
      />
      <VolumeReadout percentage={percentage} muted={muted} onCommit={(value) => onVolumeChange(value / 100)} />
    </div>
  );
}

/**
 * 右端的百分比读数：衬线加粗，与步进器的数值同一种字；三位滚轮定宽，一位数与三位数之间胶囊不伸缩。
 * 读数本身是按钮，点一下原地换成输入框，直接键入 0–100 的百分比：回车或失焦提交，Esc 放弃。
 */
function VolumeReadout({ percentage, muted, onCommit }: { percentage: number; muted: boolean; onCommit: (value: number) => void }) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState("");
  const input = useRef<HTMLInputElement>(null);
  const tone = muted ? "text-muted-foreground" : "text-foreground";

  useEffect(() => {
    if (editing) input.current?.select();
  }, [editing]);

  const commit = () => {
    setEditing(false);
    const value = Number(draft.trim().replace(/%$/, ""));
    // 空串或非数字视作放弃；越界按上下限夹住。
    if (draft.trim() && Number.isFinite(value)) onCommit(Math.min(100, Math.max(0, Math.round(value))));
  };
  const handleKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === "Enter") commit();
    if (event.key === "Escape") {
      // 只收起输入框，不让 Esc 再冒泡去关掉外层弹出层。
      event.stopPropagation();
      setEditing(false);
    }
  };

  return editing ? (
    <span className={cn("ml-1 flex w-12 items-baseline justify-end text-sm font-semibold tabular-nums", tone)}>
      <input
        ref={input}
        value={draft}
        onChange={(event) => setDraft(event.target.value.replace(/[^\d]/g, "").slice(0, 3))}
        onBlur={commit}
        onKeyDown={handleKeyDown}
        inputMode="numeric"
        aria-label="输入音量百分比"
        className="w-full min-w-0 rounded-sm bg-accent/60 px-0.5 text-right outline-none focus-visible:ring-1 focus-visible:ring-primary/50"
      />
      %
    </span>
  ) : (
    <button
      type="button"
      onClick={() => { setDraft(String(percentage)); setEditing(true); }}
      aria-label={`音量 ${percentage}%，点击输入`}
      className={cn("ml-1 flex w-12 items-baseline justify-end rounded-sm text-sm font-semibold tabular-nums transition-colors hover:bg-accent/60", tone)}
    >
      <FollowNumber value={percentage} places={3} />%
    </button>
  );
}
