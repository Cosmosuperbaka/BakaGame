import { useEffect, useRef, useState } from "react";
import {
  animate,
  AnimatePresence,
  motion,
  useMotionValue,
  useMotionValueEvent,
} from "framer-motion";
import * as Popover from "@radix-ui/react-popover";
import { Volume, Volume1, Volume2, VolumeX } from "lucide-react";
import type { LucideIcon } from "lucide-react";
import { Button } from "@/components/ui/Button";
import { Slider } from "@/components/ui/Slider";
import { useCloseFrom } from "@/hooks/UseCloseFrom";
import { duration, ease, iconTappable, popover, readoutSwap } from "@/lib/Motion";
import { cn } from "@/lib/Utils";
import { VolumeReadout } from "./VolumeReadout";

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
export function SongVolumeControl({ volume, onVolumeChange }: VolumeControlProps) {
  const [open, setOpen] = useState(false);
  useCloseFrom(open, setOpen, "sm");
  const toggleMute = useMuteToggle(volume, onVolumeChange);

  return (
    <>
      {/* 胶囊里已常驻百分比读数，静音按钮与滑块各带 aria-label，不再挂复述同样的 hover 文案 */}
      <VolumeCapsule
        volume={volume}
        onVolumeChange={onVolumeChange}
        onToggleMute={toggleMute}
        className="hidden sm:flex"
      />
      <Popover.Root open={open} onOpenChange={setOpen}>
        <Popover.Trigger asChild>
          <Button
            type="button"
            variant="ghost"
            size="icon"
            className="sm:hidden"
            aria-label="调节音量"
          >
            <VolumeGlyph volume={volume} className="h-5 w-5" />
          </Button>
        </Popover.Trigger>
        {/* 受控 + forceMount：关闭时经 AnimatePresence 播完退场再卸载，与玩家行浮层同口径。 */}
        <AnimatePresence>
          {open ? (
            <Popover.Portal forceMount>
              <Popover.Content
                forceMount
                side="bottom"
                align="end"
                sideOffset={6}
                collisionPadding={12}
                aria-label="播放音量"
                asChild
              >
                <motion.div
                  variants={popover}
                  initial="initial"
                  animate="animate"
                  exit="exit"
                  // 胶囊浮层：floating-surface 自带 rounded-md，这里显式压成全圆角。
                  className="z-popover origin-(--radix-popover-content-transform-origin) floating-surface !rounded-full p-1 shadow-md"
                >
                  {/* 触屏没有悬停：弹出层里轨道始终是粗的那一档，整行高度都能按住拖动。 */}
                  <VolumeCapsule
                    volume={volume}
                    onVolumeChange={onVolumeChange}
                    onToggleMute={toggleMute}
                    expanded
                    className="flex border-0 bg-transparent shadow-none"
                  />
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
        <motion.span
          key={key}
          variants={readoutSwap}
          initial="initial"
          animate="animate"
          exit="exit"
          className="col-start-1 row-start-1"
        >
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
}

/**
 * 胶囊本体：静音按钮、轨道与百分比读数，常驻音量条与弹出层共用。
 * 轨道细时只有 4px，滑块收起；悬停或键盘聚焦到滑块时轨道补间到 6px、滑块弹出，与 Switch 同一档 `spring.snap` 的 CSS 弹性。
 * 静音开关与离散变化时，以统一的连续动画数值驱动 Slider 与数字，滑块圆点与填充轨道严密同步平滑滑行；手动拖动时保持零延迟极速跟手。
 */
function VolumeCapsule({
  volume,
  onVolumeChange,
  onToggleMute,
  expanded = false,
  className,
}: VolumeCapsuleProps) {
  // 显示值是一个连续动画的数值：补间由 motion value 驱动，React 状态只在它变化的回调里跟随，
  // 不在 effect 里同步写状态。
  const display = useMotionValue(volume);
  const [displayVolume, setDisplayVolume] = useState(volume);
  useMotionValueEvent(display, "change", setDisplayVolume);
  const isDragging = useRef(false);
  const animControls = useRef<{ stop: () => void } | null>(null);

  // 外部 volume 变更（静音切换、输入框提交、外部重置）时，在非手动拖动下驱动平滑过渡动画
  useEffect(() => {
    if (isDragging.current) {
      display.set(volume);
      return;
    }

    // 差值已在显示精度以内：若目标是静音则强收束到 0
    if (Math.abs(volume - display.get()) < 0.002) {
      if (volume === 0 && display.get() !== 0) display.set(0);
      return;
    }

    animControls.current?.stop();
    const controls = animate(display, volume, {
      duration: duration.base,
      ease: ease.emphasized,
    });
    animControls.current = controls;
    return () => {
      controls.stop();
    };
  }, [volume, display]);

  const isMuted = volume === 0;
  // 静音时若补间尾段极微小（< 0.008，对应百分比四舍五入前临界），直接归零，杜绝读数残留在 1
  const effectiveVolume = isMuted && displayVolume < 0.008 ? 0 : displayVolume;
  const percentage = Math.round(effectiveVolume * 100);
  const muted = volume === 0;
  const spring = "duration-(--motion-spring-snap-duration) ease-(--motion-spring-snap)";

  return (
    <div
      data-expanded={expanded || undefined}
      className={cn(
        "group/volume h-9 items-center gap-1 rounded-full border bg-panel px-1 shadow-sm",
        className
      )}
    >
      <motion.button
        type="button"
        {...iconTappable}
        onClick={onToggleMute}
        aria-label={muted ? "取消静音" : "静音"}
        aria-pressed={muted}
        className={cn(
          "flex h-7 w-7 shrink-0 items-center justify-center rounded-full transition-colors hover:bg-accent",
          muted ? "text-muted-foreground" : "text-foreground"
        )}
      >
        <VolumeGlyph volume={muted ? 0 : effectiveVolume} className="h-4 w-4" />
      </motion.button>
      <Slider
        className="h-full w-28"
        trackClassName={cn(
          "h-1 transition-[height]",
          spring,
          "group-hover/volume:h-1.5 group-focus-within/volume:h-1.5 group-data-expanded/volume:h-1.5"
        )}
        thumbClassName={cn(
          // 收起时缩到一半并透明，而不是缩成 0：包围盒仍在，自动化与读屏按可见元素找得到滑块。
          "scale-50 opacity-0 transition-[scale,opacity,background-color]",
          spring,
          "group-hover/volume:scale-100 group-hover/volume:opacity-100 group-focus-within/volume:scale-100 group-focus-within/volume:opacity-100",
          "group-data-expanded/volume:scale-100 group-data-expanded/volume:opacity-100"
        )}
        value={[effectiveVolume]}
        min={0}
        max={1}
        step={0.01}
        onPointerDown={() => {
          isDragging.current = true;
          animControls.current?.stop();
          animControls.current = null;
        }}
        onPointerUp={() => {
          isDragging.current = false;
        }}
        onValueChange={([val]) => {
          animControls.current?.stop();
          animControls.current = null;
          display.set(val);
          onVolumeChange(val);
        }}
        aria-label="播放音量"
      />
      <VolumeReadout
        percentage={percentage}
        muted={muted}
        onCommit={(value) => onVolumeChange(value / 100)}
      />
    </div>
  );
}
