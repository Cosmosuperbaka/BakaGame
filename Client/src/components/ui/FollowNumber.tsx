import { useEffect, useRef } from "react";
import { motion, useReducedMotion, useSpring, useTransform, type MotionValue } from "framer-motion";
import { digitRoll } from "@/lib/Motion";
import { cn } from "@/lib/Utils";

/**
 * 每列一只 11 格的滚轮：第 0 格留空（高位不存在时），其后是 0–9。
 * 空格用不换行空格（U+00A0）：普通空格会被折叠，那一格就没有高度。
 */
const SLOTS = [String.fromCharCode(0xa0), ..."0123456789"];
const SLOT_COUNT = SLOTS.length;
/** 字形画在伪元素里、不写文本节点：按文字查找、复制与读屏都只看到真实数值。 */
const GLYPH = "before:content-[attr(data-glyph)]";

/** 某一位落在滚轮的哪一格：这一位超出数字长度时取空格。 */
function slotOf(value: number, place: number): number {
  const digits = String(Math.abs(Math.round(value)));
  const digit = digits[digits.length - 1 - place];
  return digit === undefined ? 0 : Number(digit) + 1;
}

/** 把格距折到 [-半圈, 半圈)：滚轮上相邻的格子从上下两侧露出，不会整圈绕回来。 */
function wrapOffset(offset: number): number {
  const half = SLOT_COUNT / 2;
  return ((((offset + half) % SLOT_COUNT) + SLOT_COUNT) % SLOT_COUNT) - half;
}

/**
 * 跟手的数字读数（音量百分比这类连续拖动的值）。
 *
 * 与 `AnimatedNumber` 的区别：那边每次变化都从旧值重新滚一遍，变化一密就互相打断、看起来像被吞掉；
 * 这里每一位是一只滚轮，位置由一条弹簧（`digitRoll.follow`）驱动，目标变了就带着当前速度续上，
 * 拖得再快也是连贯地追过去。值增加时滚轮向前转、减少时向后转，跨过 9/0 接着转而不倒退。
 * 真实数值以读屏文字给出，滚轮整体 `aria-hidden`；减弱动效下直接落位。
 */
export function FollowNumber({ value, places, className }: {
  value: number;
  /** 固定的位数（音量 0–100 为 3），高位不足时那一列显示空格，读数宽度不随位数伸缩 */
  places: number;
  className?: string;
}) {
  const columns = Array.from({ length: places }, (_, index) => places - 1 - index);
  return (
    <span className={cn("relative inline-flex tabular-nums", className)}>
      <span className="sr-only">{Math.round(value)}</span>
      <span aria-hidden className="inline-flex">
        {columns.map((place) => <DigitWheel key={place} slot={slotOf(value, place)} value={value} />)}
      </span>
    </span>
  );
}

function DigitWheel({ slot, value }: { slot: number; value: number }) {
  const reduced = useReducedMotion();
  // 位置不取模、一路累加：方向由数值的增减决定，弹簧只管追这个连续的目标。
  const target = useRef(slot);
  const previous = useRef({ slot, value });
  const position = useSpring(slot, digitRoll.follow);

  useEffect(() => {
    const last = previous.current;
    previous.current = { slot, value };
    if (last.slot === slot) return;
    const forward = (slot - last.slot + SLOT_COUNT) % SLOT_COUNT;
    target.current += value >= last.value ? forward : forward - SLOT_COUNT;
    if (reduced) position.jump(target.current);
    else position.set(target.current);
  }, [slot, value, reduced, position]);

  return (
    <span className="relative inline-block">
      {/* 用一格真实字形撑开列宽、行高与基线，滚轮的格子都叠在它上面。
          裁切放在内层的绝对定位容器上：inline-block 自身一旦 overflow-hidden，基线会落到盒子底边，与「%」对不齐。 */}
      <span data-glyph="0" className={cn(GLYPH, "invisible")} />
      <span className="absolute inset-0 overflow-hidden">
        {SLOTS.map((glyph, index) => <WheelSlot key={index} index={index} glyph={glyph} position={position} />)}
      </span>
    </span>
  );
}

function WheelSlot({ index, glyph, position }: { index: number; glyph: string; position: MotionValue<number> }) {
  const y = useTransform(position, (current) => `${wrapOffset(index - current) * 100}%`);
  return <motion.span data-glyph={glyph} className={cn(GLYPH, "absolute inset-0 text-center")} style={{ y }} />;
}
