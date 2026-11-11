import { cn } from "@/lib/Utils";

/** 走势图的画幅：与一行小字等高，宽度只够看出起伏，不抢行内的数字。 */
const WIDTH = 72;
const HEIGHT = 18;
const INSET = 2;
/** 每个点至少占的像素宽：120 格挤进 72 像素会把逐格抖动画成一团毛线，先按像素分桶取均值。 */
const POINT_SPACING = 2;

/**
 * 把序列按桶合并成不超过画幅能分辨的点数：桶内取有读数的均值，整桶都没有读数时留空（断线）。
 * 只影响走势线的平滑程度，逐格的确切延迟在条带悬停说明里看。
 */
const bucketize = (values: readonly (number | null)[]): (number | null)[] => {
  const buckets = Math.max(2, Math.floor((WIDTH - INSET * 2) / POINT_SPACING));
  if (values.length <= buckets) return [...values];
  return Array.from({ length: buckets }, (_, bucket) => {
    const from = Math.floor((bucket * values.length) / buckets);
    const to = Math.floor(((bucket + 1) * values.length) / buckets);
    const known = values.slice(from, to).filter((value): value is number => value !== null);
    return known.length > 0 ? known.reduce((sum, value) => sum + value, 0) / known.length : null;
  });
};

/**
 * 延迟走势：实时窗口里每格的平均延迟连成一条线，旁边的数字给当下，这条线给「最近是不是在变慢」。
 *
 * 没有读数的时段把线断开，不把缺口连成一段平稳的假走势；有效点不足两个时不画。
 * 纵轴按窗口内的最小最大值铺满，只读相对起伏，具体数值以悬停条格与行内数字为准，
 * 因此整张图对读屏隐藏。
 */
export function LatencySparkline({
  values: raw,
  className,
}: {
  values: readonly (number | null)[];
  className?: string;
}) {
  const values = bucketize(raw);
  const known = values.filter((value): value is number => value !== null);
  if (known.length < 2) return null;

  const min = Math.min(...known);
  const max = Math.max(...known);
  const step = (WIDTH - INSET * 2) / Math.max(1, values.length - 1);
  const xOf = (index: number) => INSET + index * step;
  const yOf = (value: number) =>
    max === min ? HEIGHT / 2 : INSET + (HEIGHT - INSET * 2) * (1 - (value - min) / (max - min));

  const segments: string[] = [];
  let current = "";
  let lastIndex = -1;
  values.forEach((value, index) => {
    if (value === null) {
      if (current) segments.push(current);
      current = "";
      return;
    }
    current += `${current ? "L" : "M"}${xOf(index).toFixed(1)} ${yOf(value).toFixed(1)}`;
    lastIndex = index;
  });
  if (current) segments.push(current);
  const last = values[lastIndex];

  return (
    <svg
      aria-hidden="true"
      width={WIDTH}
      height={HEIGHT}
      viewBox={`0 0 ${WIDTH} ${HEIGHT}`}
      className={cn("shrink-0 overflow-visible text-muted-foreground", className)}
    >
      <path
        d={segments.join(" ")}
        fill="none"
        stroke="currentColor"
        strokeOpacity={0.7}
        strokeWidth={1.25}
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      {last !== null && last !== undefined ? (
        <circle cx={xOf(lastIndex)} cy={yOf(last)} r={2} className="fill-foreground" />
      ) : null}
    </svg>
  );
}
