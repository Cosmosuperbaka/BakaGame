import { useEffect, useRef, useState } from "react";
import { AnimatePresence, motion } from "framer-motion";
import * as Popover from "@radix-ui/react-popover";
import { Volume, Volume1, Volume2, VolumeX } from "lucide-react";
import type { LucideIcon } from "lucide-react";
import { AnimatedNumber } from "@/components/ui/AnimatedNumber";
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
        <Popover.Portal>
          <Popover.Content side="bottom" align="end" sideOffset={6} collisionPadding={12} aria-label="播放音量" asChild>
            <motion.div
              variants={popover}
              initial="initial"
              animate="animate"
              className="z-popover origin-(--radix-popover-content-transform-origin) rounded-full floating-surface p-1 shadow-md"
            >
              {/* 触屏没有悬停：弹出层里轨道始终是粗的那一档，整行高度都能按住拖动。 */}
              <VolumeCapsule volume={volume} onVolumeChange={onVolumeChange} onToggleMute={toggleMute} expanded className="flex border-0 bg-transparent shadow-none" />
            </motion.div>
          </Popover.Content>
        </Popover.Portal>
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
      className={cn("group/volume h-9 items-center gap-1 rounded-full border bg-panel pr-3 pl-1 shadow-sm", className)}
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
      {/* 读数定宽：三位数与一位数之间切换时胶囊不伸缩。 */}
      <span className={cn("ml-1 flex w-10 items-baseline justify-end font-sans text-xs tabular-nums", muted ? "text-muted-foreground" : "text-foreground")}>
        <AnimatedNumber value={percentage} />%
      </span>
    </div>
  );
}
