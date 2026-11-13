import { useEffect, useRef, useState, type KeyboardEvent } from "react";
import { motion, useReducedMotion, useSpring, useTransform, type MotionValue } from "framer-motion";
import { digitRoll, iconTappable } from "@/lib/Motion";
import { cn } from "@/lib/Utils";

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

function DigitItem({
  index,
  char,
  position,
}: {
  index: number;
  char: string;
  position: MotionValue<number>;
}) {
  const offset = useTransform(position, (current) => wrapDigitOffset(index - current));
  const y = useTransform(offset, (o) => `${o * 100}%`);
  const opacity = useTransform(offset, (o) => Math.max(0, 1 - Math.abs(o) * 0.75));
  return (
    <motion.span
      data-glyph={char}
      className={cn(
        GLYPH,
        "absolute inset-0 flex items-center justify-center font-semibold tabular-nums leading-none"
      )}
      style={{ y, opacity }}
    />
  );
}

function DigitColumn({ digit, value }: { digit: number; value: number }) {
  const reduced = useReducedMotion();
  const target = useRef(digit);
  const previous = useRef({ digit, value });
  const position = useSpring(digit, digitRoll.follow);

  useEffect(() => {
    const last = previous.current;
    previous.current = { digit, value };
    if (last.digit === digit) return;

    // 当数值增加时向前滚动（新数字从下方升起推进）；数值减少时向后滚动（从上方落下回退）
    const isAscending = value >= last.value;
    const forward = (digit - last.digit + DIGIT_COUNT) % DIGIT_COUNT;
    const backward = (last.digit - digit + DIGIT_COUNT) % DIGIT_COUNT;
    target.current += isAscending ? forward : -backward;

    if (reduced) position.jump(target.current);
    else position.set(target.current);
  }, [digit, value, reduced, position]);

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
  const digits = String(num).split("").map(Number);
  const totalDigits = digits.length;

  return (
    <span
      className={cn(
        "relative inline-flex items-center justify-center tabular-nums leading-none",
        className
      )}
    >
      <span className="sr-only">{num}</span>
      <span aria-hidden="true" className="inline-flex items-center">
        {digits.map((d, i) => {
          const place = totalDigits - 1 - i;
          return <DigitColumn key={place} digit={d} value={num} />;
        })}
      </span>
    </span>
  );
}

/**
 * 右端的音量数值与输入框：与左侧静音开关保持对称的圆形大小（h-7 w-7 rounded-full）。
 * 常态下居中显示自然宽度的连续弹簧滚动数值（不带多余前导占位与 %）；
 * 点击原地切换为同尺寸同圆角的圆形输入框，居中直接键入 0–100 的数值：回车或失焦提交，Esc 放弃。
 */
export function VolumeReadout({
  percentage,
  muted,
  onCommit,
}: {
  percentage: number;
  muted: boolean;
  onCommit: (value: number) => void;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState("");
  const input = useRef<HTMLInputElement>(null);
  const readout = useRef<HTMLButtonElement>(null);
  /** 键盘提交或放弃后输入框卸载，焦点会落到 body；等读数按钮重新挂上再还给它。失焦提交不抢焦点。 */
  const restoreFocus = useRef(false);
  const tone = muted ? "text-muted-foreground" : "text-foreground";

  useEffect(() => {
    if (editing) {
      // 不依赖 select() 顺带聚焦：并非所有环境都会这样做，键盘用户要直接能键入。
      input.current?.focus();
      input.current?.select();
    } else if (restoreFocus.current) {
      restoreFocus.current = false;
      readout.current?.focus();
    }
  }, [editing]);

  const commit = () => {
    setEditing(false);
    const value = Number(draft.trim().replace(/%$/, ""));
    // 空串或非数字视作放弃；越界按上下限夹住。
    if (draft.trim() && Number.isFinite(value))
      onCommit(Math.min(100, Math.max(0, Math.round(value))));
  };
  const handleKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === "Enter") {
      // 焦点马上要回到读数按钮，同一次按键不能再去触发它：拦掉默认行为，否则输入框刚收起又被点开。
      event.preventDefault();
      restoreFocus.current = true;
      commit();
    }
    if (event.key === "Escape") {
      // 只收起输入框，不让 Esc 再冒泡去关掉外层弹出层。
      event.stopPropagation();
      restoreFocus.current = true;
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
        // 只保留浅底表明「这是可编辑的读数」，焦点指示沿用全站那一条 2px `--ring` 实线
        "h-7 w-7 shrink-0 rounded-full bg-accent/80 p-0 text-center text-xs font-semibold tabular-nums leading-7",
        tone
      )}
    />
  ) : (
    <motion.button
      ref={readout}
      type="button"
      {...iconTappable}
      onClick={() => {
        setDraft(String(percentage));
        setEditing(true);
      }}
      aria-label={`音量 ${percentage}%，点击输入`}
      className={cn(
        "flex h-7 w-7 shrink-0 items-center justify-center rounded-full text-xs font-semibold tabular-nums transition-colors hover:bg-accent",
        tone
      )}
    >
      <RollingVolumeNumber value={percentage} />
    </motion.button>
  );
}
