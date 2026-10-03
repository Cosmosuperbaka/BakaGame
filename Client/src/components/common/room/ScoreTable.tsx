import { Fragment, useId, type ReactNode } from "react";
import { motion } from "framer-motion";
import { AnimatedNumber } from "@/components/ui/AnimatedNumber";
import { contributorWash, contributorWashDelay, scoreRevealDelay, scoreRollDelay, scoreRow, winnerSweep, winnerSweepDelay } from "@/lib/Motion";
import { cn } from "@/lib/Utils";

export interface ScoreTableColumn {
  key: string;
  /** 表头取两字，手机上不折行也放得下 */
  header: string;
  /** 数值列默认右对齐，徽章一类的文本列取 left */
  align?: "left" | "right";
  /** strong：累计分或唯一的得分列，加粗；muted：辅助计数，弱化。数字一律不着状态色 */
  tone?: "strong" | "muted";
  /** 增量列：正数补「+」，零与负数照原样 */
  signed?: boolean;
}

export interface ScoreTableRow {
  key: string;
  name: ReactNode;
  /** 名字下方的弱化次行，如 CCB 的得分明细；按项传入，以「·」相连 */
  detail?: ReactNode[];
  cells: Record<string, ReactNode>;
  /** 列 key → 滚动起点：这一列的数字在行落定后从起点逐位滚到终值（总分从赛前分滚起，CCB 的本局得分从 0 滚起） */
  rollFrom?: Record<string, number>;
  /** 本局做出贡献（CCB 猜中、猜歌答对）：行落定后浮起常驻的浅底，让战报读得出这几分是谁挣的 */
  contributor?: boolean;
  /** 第一名或获胜阵营：整表揭示完后有一道光扫过这一行，只播一次 */
  winner?: boolean;
}

// 数值列比名字列收紧内边距，末列补回 pr-4 与区块标题对齐。
const valueCell = "whitespace-nowrap px-3 last:pr-4";
const rowClass = "border-b border-background align-baseline last:border-b-0";

const alignClass = (column: ScoreTableColumn) => (column.align === "left" ? "text-left" : "text-right");

/**
 * 胜者行的扫光。`tr` 上的定位各浏览器不一致，光层挂在首格里，宽度取滚动容器的 `100cqw` 横跨整行；
 * 外层裁掉行外的光带，`-z-10` 让光从文字底下经过（叠在区块底色之上，区块 `isolate` 兜住层叠）。
 * 渐变只占光带中间 30%–70%，与 `winnerSweep` 的起止位移配套：静止时光带整段停在行外。
 * 光取比 `muted` 更亮的一档表面：亮色是 card，暗色 card 与 muted 几乎同明度，取 secondary（Design §3.2）。
 */
function WinnerSweep({ delay }: { delay: number }) {
  return (
    <span aria-hidden className="pointer-events-none absolute inset-y-0 left-0 -z-10 w-[100cqw] overflow-hidden">
      <motion.span
        className="absolute inset-0 bg-linear-to-r from-transparent from-30% via-card to-transparent to-70% dark:via-secondary"
        initial={winnerSweep.initial}
        animate={winnerSweep.animate}
        transition={{ ...winnerSweep.transition, delay }}
      />
    </span>
  );
}

/**
 * 贡献者行的浅底。与扫光同样把定位落在首格里、宽度取滚动容器的 `100cqw` 横跨整行：
 * `tr` 上的定位各浏览器不一致，格子只负责撑起行高与基线。`-z-10` 压在文字底下、底纸之上，
 * 因此数字与名字仍按原色读，底色只交代「这几分是谁挣的」。区块 `isolate` 兜住层叠。
 */
function ContributorWash({ delay }: { delay: number }) {
  return (
    <motion.span
      aria-hidden
      className="pointer-events-none absolute inset-y-0 left-0 -z-10 w-[100cqw] bg-primary/10"
      initial={contributorWash.initial}
      animate={contributorWash.animate}
      transition={{ ...contributorWash.transition, delay }}
    />
  );
}

/**
 * 三个游戏共用的结算得分表。区块标题经 `aria-labelledby` 作表格的可访问名，
 * 玩家名是行标题，明细收在名字下方；数值列不折行，余宽留给名字。
 * 各行逐行揭示（`scoreRow`），顺序见 `ranked`。
 */
export function ScoreTable({
  title,
  columns,
  rows,
  ranked = false,
}: {
  title: string;
  columns: ScoreTableColumn[];
  rows: ScoreTableRow[];
  /** 行按名次排列、第一名在最上：自末行往上揭示，第一名最后落定。缺省按座次自上而下（谁是卧底的身份开牌） */
  ranked?: boolean;
}) {
  const titleId = useId();
  const sweepDelay = winnerSweepDelay(rows.length);
  const body = rows.map((row, rowIndex) => {
    const rollDelay = scoreRollDelay(rowIndex, rows.length, ranked);
    const washDelay = contributorWashDelay(rowIndex, rows.length, ranked);
    const layered = row.contributor || row.winner;
    const cells = (
      <>
        <th scope="row" className={cn("py-2.5 pl-4 pr-3 text-left font-normal", layered && "relative")}>
          {row.contributor ? <ContributorWash delay={washDelay} /> : null}
          {row.winner ? <WinnerSweep delay={sweepDelay} /> : null}
          <span className="block font-medium [overflow-wrap:anywhere]">{row.name}</span>
          {row.detail?.length ? (
            <span className="mt-0.5 block text-xs text-muted-foreground">
              {/* 只在项与项之间折行；间隔号随前一项，不落到行首 */}
              {row.detail.map((item, index, items) => (
                <Fragment key={index}>
                  {index > 0 ? " " : null}
                  <span className="whitespace-nowrap">
                    {item}
                    {index < items.length - 1 ? " ·" : null}
                  </span>
                </Fragment>
              ))}
            </span>
          ) : null}
        </th>
        {columns.map((column) => {
          const value = row.cells[column.key];
          const from = row.rollFrom?.[column.key];
          return (
            <td
              key={column.key}
              className={cn(
                valueCell,
                alignClass(column),
                "py-2.5 tabular-nums",
                column.tone === "strong" && "font-semibold",
                column.tone === "muted" && "text-muted-foreground",
              )}
            >
              {typeof value === "number" && from !== undefined ? (
                // 累计分滚动时在左侧浮起「+N」；增量列本身就是这次的分数，只滚不浮。
                <AnimatedNumber
                  value={value}
                  from={from}
                  delay={rollDelay}
                  signed={column.signed}
                  gain={column.signed ? undefined : "before"}
                />
              ) : column.signed && typeof value === "number" && value > 0 ? `+${value}` : value}
            </td>
          );
        })}
      </>
    );
    return (
      <motion.tr
        key={row.key}
        variants={scoreRow}
        custom={scoreRevealDelay(rowIndex, rows.length, ranked)}
        initial="initial"
        animate="animate"
        className={rowClass}
      >
        {cells}
      </motion.tr>
    );
  });
  return (
    <section className="isolate overflow-hidden rounded-md bg-muted">
      <div className="border-b border-background px-4 py-2.5">
        <h3 id={titleId} className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">{title}</h3>
      </div>
      {/* 窄屏或系统放大字号时表格可能放不下：只让表格横滚，数值列不被圆角容器裁掉，标题留在原位。容器查询供胜者扫光取行宽 */}
      <div className="@container overflow-x-auto">
        <table aria-labelledby={titleId} className="w-full text-sm">
          <thead>
            {/* 名字列的下限防止短名被挤成逐字折行：扣去内边距仍放得下三个字，四列的表在 360 宽的手机上也不横滚 */}
            <tr className="border-b border-background text-xs text-muted-foreground">
              <th scope="col" className="min-w-18 py-2 pl-4 pr-3 text-left font-medium">玩家</th>
              {columns.map((column) => (
                <th key={column.key} scope="col" className={cn(valueCell, alignClass(column), "py-2 font-medium")}>
                  {column.header}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>{body}</tbody>
        </table>
      </div>
    </section>
  );
}
