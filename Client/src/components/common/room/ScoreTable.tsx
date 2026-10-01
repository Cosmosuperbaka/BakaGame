import { Fragment, useId, type ReactNode } from "react";
import { motion } from "framer-motion";
import { listContainer, listItem } from "@/lib/Motion";
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
}

// 数值列比名字列收紧内边距，末列补回 pr-4 与区块标题对齐。
const valueCell = "whitespace-nowrap px-3 last:pr-4";
const rowClass = "border-b border-background align-baseline last:border-b-0";

const alignClass = (column: ScoreTableColumn) => (column.align === "left" ? "text-left" : "text-right");

/**
 * 三个游戏共用的结算得分表。区块标题经 `aria-labelledby` 作表格的可访问名，
 * 玩家名是行标题，明细收在名字下方；数值列不折行，余宽留给名字。
 */
export function ScoreTable({
  title,
  columns,
  rows,
  reveal = false,
}: {
  title: string;
  columns: ScoreTableColumn[];
  rows: ScoreTableRow[];
  /** 逐行揭示，供谁是卧底的身份开牌；其余结算表整块出现 */
  reveal?: boolean;
}) {
  const titleId = useId();
  const body = rows.map((row) => {
    const cells = (
      <>
        <th scope="row" className="py-2.5 pl-4 pr-3 text-left font-normal">
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
              {column.signed && typeof value === "number" && value > 0 ? `+${value}` : value}
            </td>
          );
        })}
      </>
    );
    return reveal ? (
      <motion.tr key={row.key} variants={listItem} className={rowClass}>{cells}</motion.tr>
    ) : (
      <tr key={row.key} className={rowClass}>{cells}</tr>
    );
  });
  return (
    <section className="overflow-hidden rounded-md bg-muted">
      <div className="border-b border-background px-4 py-2.5">
        <h3 id={titleId} className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">{title}</h3>
      </div>
      {/* 窄屏或系统放大字号时表格可能放不下：只让表格横滚，数值列不被圆角容器裁掉，标题留在原位 */}
      <div className="overflow-x-auto">
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
          {reveal ? (
            <motion.tbody variants={listContainer(rows.length)} initial="initial" animate="animate">
              {body}
            </motion.tbody>
          ) : (
            <tbody>{body}</tbody>
          )}
        </table>
      </div>
    </section>
  );
}
