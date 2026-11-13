import { Fragment, type ReactNode } from "react";

/**
 * 以间隔号相连的一串项：只在项与项之间折行，间隔号随前一项、不落到行首。
 * 项的排版（不断行、超长截断）各处不同，由 `itemClassName` 决定；这里只管结构。
 */
export function DotSeparated({
  items,
  itemClassName,
}: {
  items: ReactNode[];
  itemClassName: string;
}) {
  return (
    <>
      {items.map((item, index) => (
        <Fragment key={index}>
          {index > 0 ? " " : null}
          <span className={itemClassName}>
            {item}
            {index < items.length - 1 ? " ·" : null}
          </span>
        </Fragment>
      ))}
    </>
  );
}
