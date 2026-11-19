import * as React from "react";
import { cn } from "@/lib/Utils";

/**
 * 纵向滚动区。滚动条在全站隐藏，原生滚动已经够用，不再借组件库的滚动容器。
 * 自己就是滚动视口：`data-scroll-region` 供页面读取与自动贴底定位滚动区，不依赖任何第三方内部属性。
 * 这里的内边距会随内容一起滚动；要让内容在内边距处被裁切，内边距放在外层。
 */
const ScrollArea = React.forwardRef<HTMLDivElement, React.ComponentPropsWithoutRef<"div">>(
  ({ className, ...props }, ref) => (
    <div
      ref={ref}
      data-scroll-region=""
      className={cn("scrollbar-hidden relative overflow-y-auto overflow-x-hidden", className)}
      {...props}
    />
  )
);
ScrollArea.displayName = "ScrollArea";

export { ScrollArea };
