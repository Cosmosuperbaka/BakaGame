import { useEffect, useRef, useState, type KeyboardEvent } from "react";
import { AnimatePresence, motion, useReducedMotion, useSpring, useTransform, type MotionValue } from "framer-motion";
import * as Popover from "@radix-ui/react-popover";
import { Volume, Volume1, Volume2, VolumeX } from "lucide-react";
import type { LucideIcon } from "lucide-react";
import { Button } from "@/components/ui/Button";
import { Slider } from "@/components/ui/Slider";
import { useCloseFrom } from "@/hooks/UseCloseFrom";
import { digitRoll, iconTappable, popover, readoutSwap } from "@/lib/Motion";
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

  return (
    <>
      {/* 胶囊里已常驻百分比读数，静音按钮与滑块各带 aria-label，不再挂复述同样的 hover 文案 */}
      <VolumeCapsule volume={volume} onVolumeChange={onVolumeChange} onToggleMute={toggleMute} className="hidden sm:flex" />
      <Popover.Root open={open} onOpenChange={setOpen}>
        <Popover.Trigger asChild>
          <Button type="button" variant="ghost" size="icon" className="sm:hidden" aria-label="调节音量">
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
}

/**
 * 0–9 单个数字槽位的无缝循环滚轮。
 * 不设多余空格槽，10 个真实数字均匀环绕；当值增加（如从 0 向上拖动）时，滚轮自下方向上滚动推进。
 */
const DIGITS = ["0", "1", "2", "3", "4", "5", "6", "7", "8", "9"];
const DIGIT_COUNT = DIGITS.length;
const GLYPH = "before:content-[attr(data-glyph)]";

function wrapDigitOffset(offset: number): number {
  const half = DIGIT_COUNT / 2;
  return ((((offset + half) % DIGIT_COUNT) + DIGIT_COUNT) % DIGIT_COUNT) - half;
}

function DigitItem({ index, char, position }: { index: number; char: string; position: MotionValue<number> }) {
  const offset = useTransform(position, (current) => wrapDigitOffset(index - current));
  const y = useTransform(offset, (o) => `${o * 100}%`);
  const opacity = useTransform(offset, (o) => Math.max(0, 1 - Math.abs(o) * 0.75));
  return (
    <motion.span
      data-glyph={char}
      className={cn(GLYPH, "absolute inset-0 flex items-center justify-center font-semibold tabular-nums leading-none")}
      style={{ y, opacity }}
    />
  );
}

function DigitColumn({ digit, isAscending }: { digit: number; isAscending: boolean }) {
  const reduced = useReducedMotion();
  const target = useRef(digit);
  const prevDigit = useRef(digit);
  const position = useSpring(digit, digitRoll.follow);

  useEffect(() => {
    const last = prevDigit.current;
    prevDigit.current = digit;
    if (last === digit) return;
    const forward = (digit - last + DIGIT_COUNT) % DIGIT_COUNT;
    const backward = (last - digit + DIGIT_COUNT) % DIGIT_COUNT;
    // 增加时向上滚（新字从下方升起，从 0 向上推进）；减少时向下滚
    target.current += isAscending ? forward : -backward;
    if (reduced) position.jump(target.current);
    else position.set(target.current);
  }, [digit, isAscending, reduced, position]);

  return (
    <span className="relative inline-block h-[1em] w-[0.62em] overflow-hidden align-baseline">
      {/* 隐藏的 0 撑开单字符自然宽度与高度，数字不写在 DOM 文本节点避免读屏/单测重复 */}
      <span data-glyph="0" className={cn(GLYPH, "invisible")} />
      <span className="absolute inset-0">
        {DIGITS.map((d, index) => (
          <DigitItem key={index} index={index} char={d} position={position} />
        ))}
      </span>
    </span>
  );
}

/**
 * 具有方向感知与连续物理弹簧跟手的音量数字。
 * 无前导空格，按真实位数（0–9 为 1 位，10–99 为 2 位，100 为 3 位）居中呈现。
 * 拖动与恢复时数值增加自下而上顶进，数值减少自上而下回退。
 */
function RollingVolumeNumber({ value, className }: { value: number; className?: string }) {
  const num = Math.min(100, Math.max(0, Math.round(value)));
  const prevValue = useRef(num);
  const isAscending = useRef(true);

  if (num !== prevValue.current) {
    isAscending.current = num >= prevValue.current;
    prevValue.current = num;
  }

  const digits = String(num).split("").map(Number);
  const totalDigits = digits.length;

  return (
    <span className={cn("relative inline-flex items-center justify-center tabular-nums leading-none", className)}>
      <span className="sr-only">{num}</span>
      <span aria-hidden="true" className="inline-flex items-center">
        {digits.map((d, i) => {
          const place = totalDigits - 1 - i;
          return <DigitColumn key={place} digit={d} isAscending={isAscending.current} />;
        })}
      </span>
    </span>
  );
}

/**
 * 胶囊本体：静音按钮、轨道与百分比读数，常驻音量条与弹出层共用。
 * 轨道细时只有 4px，滑块收起；悬停或键盘聚焦到滑块时轨道补间到 6px、滑块弹出，与 Switch 同一档 `spring.snap` 的 CSS 弹性。
 * 静音开关或直接输入提交时，滑块与填充轨道带平滑移动动效；手动拖动时保持零延迟极速跟手。
 */
function VolumeCapsule({ volume, onVolumeChange, onToggleMute, expanded = false, className }: VolumeCapsuleProps) {
  const percentage = Math.round(volume * 100);
  const muted = volume === 0;
  const spring = "duration-(--motion-spring-snap-duration) ease-(--motion-spring-snap)";
  const [smoothMoving, setSmoothMoving] = useState(false);
  const smoothTimer = useRef<number | null>(null);

  const triggerSmoothMove = () => {
    setSmoothMoving(true);
    if (smoothTimer.current) window.clearTimeout(smoothTimer.current);
    smoothTimer.current = window.setTimeout(() => setSmoothMoving(false), 350);
  };

  const handleToggleMute = () => {
    triggerSmoothMove();
    onToggleMute();
  };

  return (
    <div
      data-expanded={expanded || undefined}
      className={cn("group/volume h-9 items-center gap-1 rounded-full border bg-panel px-1 shadow-sm", className)}
    >
      <motion.button
        type="button"
        {...iconTappable}
        onClick={handleToggleMute}
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
        rangeClassName={cn(
          smoothMoving && "transition-[left,right,width] duration-(--motion-spring-snap-duration) ease-(--motion-spring-snap)",
        )}
        thumbClassName={cn(
          // 收起时缩到一半并透明，而不是缩成 0：包围盒仍在，自动化与读屏按可见元素找得到滑块。
          "scale-50 opacity-0 transition-[scale,opacity,background-color]", spring,
          "group-hover/volume:scale-100 group-hover/volume:opacity-100 group-focus-within/volume:scale-100 group-focus-within/volume:opacity-100",
          "group-data-expanded/volume:scale-100 group-data-expanded/volume:opacity-100",
          smoothMoving && "transition-[left,transform,scale,opacity,background-color] duration-(--motion-spring-snap-duration) ease-(--motion-spring-snap)",
        )}
        value={[volume]}
        min={0}
        max={1}
        step={0.01}
        onPointerDown={() => setSmoothMoving(false)}
        onValueChange={([value]) => {
          setSmoothMoving(false);
          onVolumeChange(value);
        }}
        aria-label="播放音量"
      />
      <VolumeReadout
        percentage={percentage}
        muted={muted}
        onCommit={(value) => {
          triggerSmoothMove();
          onVolumeChange(value / 100);
        }}
      />
    </div>
  );
}

/**
 * 右端的音量数值与输入框：与左侧静音开关保持对称的圆形大小（h-7 w-7 rounded-full）。
 * 常态下居中显示自然宽度的连续弹簧滚动数值（不带多余前导占位与 %）；
 * 点击原地切换为同尺寸同圆角的圆形输入框，居中直接键入 0–100 的数值：回车或失焦提交，Esc 放弃。
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
    <input
      ref={input}
      value={draft}
      onChange={(event) => setDraft(event.target.value.replace(/[^\d]/g, "").slice(0, 3))}
      onBlur={commit}
      onKeyDown={handleKeyDown}
      inputMode="numeric"
      aria-label="输入音量百分比"
      className={cn(
        "h-7 w-7 shrink-0 rounded-full bg-accent/80 p-0 text-center text-xs font-semibold tabular-nums leading-7 outline-none ring-1 ring-primary/50 focus:ring-1 focus:ring-primary",
        tone,
      )}
    />
  ) : (
    <motion.button
      type="button"
      {...iconTappable}
      onClick={() => { setDraft(String(percentage)); setEditing(true); }}
      aria-label={`音量 ${percentage}%，点击输入`}
      className={cn(
        "flex h-7 w-7 shrink-0 items-center justify-center rounded-full text-xs font-semibold tabular-nums transition-colors hover:bg-accent",
        tone,
      )}
    >
      <RollingVolumeNumber value={percentage} />
    </motion.button>
  );
}
