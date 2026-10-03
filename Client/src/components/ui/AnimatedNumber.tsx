import { useState } from "react";
import { motion } from "framer-motion";
import { useValueChange } from "@/hooks/UseValueChange";
import { digitRoll, gainFloat } from "@/lib/Motion";
import { cn } from "@/lib/Utils";

/**
 * 数字带：首格留空（新增的高位从这里滚出来），其后两轮 0–9，跨过 9/0 时接着滚而不倒转。
 * 空格用不换行空格（U+00A0）：普通空格会被折叠，那一格就没有高度，整条带的间距随之错位。
 */
const STRIP = [String.fromCharCode(0xa0), ..."01234567890123456789"];
/** 装饰层的字形画在伪元素里、不写文本节点：按文字查找、复制与读屏都只看到真实数值。 */
const GLYPH = "before:content-[attr(data-glyph)]";

const format = (value: number, signed: boolean) => (signed && value > 0 ? `+${value}` : String(value));
const signOf = (value: number, signed: boolean) => format(value, signed).replace(/\d/g, "");
const stripOffset = (index: number) => `${(-index * 100) / STRIP.length}%`;

interface Roll {
  from: number;
  to: number;
  serial: number;
  delay: number;
}

interface RollColumn {
  place: number;
  digit: string;
  start: number;
  end: number;
}

/** 每一位从哪一格滚到哪一格。数字 d 在第一轮的下标是 d + 1、第二轮是 d + 11：增加从第一轮往后滚，减少从第二轮往回滚，都不越界。 */
function rollColumns(from: number, to: number): RollColumn[] {
  const toDigits = String(Math.abs(to));
  const fromDigits = String(Math.abs(from));
  const up = Math.abs(to) > Math.abs(from);
  return [...toDigits].map((digit, column) => {
    const place = toDigits.length - 1 - column;
    const previous = fromDigits[fromDigits.length - 1 - place];
    const target = Number(digit);
    const start = previous === undefined ? 0 : Number(previous) + (up ? 1 : 11);
    const end = up
      ? (target + 1 >= start ? target + 1 : target + 11)
      : (target + 11 <= start ? target + 11 : target + 1);
    return { place, digit, start, end };
  });
}

/**
 * 逐位滚动的数字。真实数值始终在文档流里（可访问名、按文字查找、复制都以它为准）；
 * 滚动时它变透明、只撑开宽度与基线，上面叠一层 aria-hidden 的数字带，滚完即移除、交还普通文字。
 * 值变化时从旧值滚到新值；挂载时不滚，除非给了 `from`（结算表从赛前分滚到赛后分）。
 */
export function AnimatedNumber({
  value,
  from,
  delay = 0,
  signed = false,
  gain,
  className,
}: {
  value: number;
  /** 挂载时从这个值滚到 `value`，只在挂载时生效 */
  from?: number;
  /** 挂载那一次滚动的延迟（秒），供结算表等行落定再滚；之后的变化立即滚 */
  delay?: number;
  /** 正数补「+」，与结算表的增量列一致 */
  signed?: boolean;
  /** 增加时浮起「+N」的位置：above 在数字上方（玩家栏），before 在数字左侧（结算表，上方是表头）；缺省不浮起 */
  gain?: "above" | "before";
  className?: string;
}) {
  const change = useValueChange(value);
  const [mountRoll] = useState<Roll | null>(() =>
    from !== undefined && from !== value ? { from, to: value, serial: 0, delay } : null);
  const roll: Roll | null = change ? { ...change, delay: 0 } : mountRoll;
  const [rolled, setRolled] = useState(-1);
  const [floated, setFloated] = useState(-1);
  const columns = roll ? rollColumns(roll.from, roll.to) : [];
  // 只差符号（-3 → 3）或只少了高位（123 → 23）时各位都不动，不必叠数字带。
  const rolling = roll !== null && roll.serial > rolled && columns.some((column) => column.start !== column.end);
  const floating = roll !== null && roll.serial > floated && roll.to > roll.from;

  return (
    <span className={cn("relative inline-block tabular-nums", className)}>
      <span className={rolling ? "text-transparent" : undefined}>{format(value, signed)}</span>
      {rolling && roll ? (
        <RollingDigits
          key={`roll-${roll.serial}`}
          roll={roll}
          columns={columns}
          signed={signed}
          onDone={() => setRolled(roll.serial)}
        />
      ) : null}
      {floating && roll && gain ? (
        <GainFloat
          key={`gain-${roll.serial}`}
          amount={roll.to - roll.from}
          placement={gain}
          delay={roll.delay}
          onDone={() => setFloated(roll.serial)}
        />
      ) : null}
    </span>
  );
}

/**
 * 叠在真实数值上的数字带：每位一列，列宽由同一字形撑开（`tabular-nums` 下与底下的文字逐位对齐），
 * 列内一条竖排数字带沿增减方向滚到新值。高位比低位晚一拍，滚完的回调挂在最晚动的那一列上。
 */
function RollingDigits({ roll, columns, signed, onDone }: {
  roll: Roll;
  columns: RollColumn[];
  signed: boolean;
  onDone: () => void;
}) {
  const toSign = signOf(roll.to, signed);
  // 自左往右找第一列会动的：它的位最高、起步最晚，最后停下。
  const lastMoving = columns.find((column) => column.start !== column.end)?.place;

  return (
    <span aria-hidden className="pointer-events-none absolute inset-0 flex">
      {toSign ? (
        <motion.span
          data-glyph={toSign}
          className={GLYPH}
          initial={{ opacity: signOf(roll.from, signed) === toSign ? 1 : 0 }}
          animate={{ opacity: 1 }}
          transition={{ ...digitRoll.sign, delay: roll.delay }}
        />
      ) : null}
      {columns.map(({ place, digit, start, end }) => (
        <span key={place} className="relative overflow-hidden">
          <span data-glyph={digit} className={cn(GLYPH, "invisible")} />
          <motion.span
            className="absolute inset-x-0 top-0 flex flex-col"
            initial={{ y: stripOffset(start) }}
            animate={{ y: stripOffset(end) }}
            transition={{ ...digitRoll.transition, delay: roll.delay + place * digitRoll.stagger }}
            onAnimationComplete={place === lastMoving ? onDone : undefined}
          >
            {STRIP.map((glyph, index) => <span key={index} data-glyph={glyph} className={GLYPH} />)}
          </motion.span>
        </span>
      ))}
    </span>
  );
}

/** 「+N」浮标：自数字旁弹起、停一拍后淡出，播完即卸载。 */
function GainFloat({ amount, placement, delay, onDone }: {
  amount: number;
  placement: "above" | "before";
  delay: number;
  onDone: () => void;
}) {
  return (
    <motion.span
      aria-hidden
      data-glyph={`+${amount}`}
      className={cn(
        GLYPH,
        // 与分数本身同为衬线体：无衬线只留给 Design §4 列出的四类微型文字
        "pointer-events-none absolute whitespace-nowrap text-2xs font-semibold leading-none text-primary",
        placement === "above" ? "bottom-full right-0" : "inset-y-0 right-full mr-1 flex items-center",
      )}
      initial={gainFloat.initial}
      animate={gainFloat.animate}
      transition={{ ...gainFloat.transition, delay }}
      onAnimationComplete={onDone}
    />
  );
}
