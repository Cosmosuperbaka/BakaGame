import { useState, type ReactNode } from "react";
import { motion } from "framer-motion";
import { FlaskConical, Minus, Plus, type LucideIcon } from "lucide-react";
import { Button } from "@/components/ui/Button";
import { CollapsibleRegion, DisclosureChevron } from "@/components/ui/Collapsible";
import { headerTappable } from "@/lib/motion/Feedback";
import { spring } from "@/lib/motion/Transitions";

// 外层 overflow-hidden 会裁掉贴边的聚焦环，环向内收（DesignGuide §7）。
const HEADER_CLASS =
  "flex w-full cursor-pointer items-center gap-2 px-4 py-2.5 text-sm font-medium transition-colors hover:bg-accent hover:text-accent-foreground focus-visible:-outline-offset-2";

export interface TestControllerShellProps {
  title: string;
  /** 内容区的内边距与分组间距由各款控制器自己定，外壳不替它们统一。 */
  bodyClassName: string;
  children: ReactNode;
}

/** 测试房间控制器的浮层外壳：标题行开合 + 折叠内容区，各款只交进自己的分组。 */
export function TestControllerShell({ title, bodyClassName, children }: TestControllerShellProps) {
  const [open, setOpen] = useState(true);

  return (
    <motion.div
      layout
      transition={spring.settle}
      className="w-full max-w-full overflow-hidden floating-surface shadow-lg md:w-96"
    >
      <motion.button
        type="button"
        onClick={() => setOpen((value) => !value)}
        aria-expanded={open}
        {...headerTappable}
        className={HEADER_CLASS}
      >
        <FlaskConical className="h-4 w-4 text-primary" />
        <span>{title}</span>
        <DisclosureChevron open={open} className="ml-auto text-muted-foreground" />
      </motion.button>
      <CollapsibleRegion open={open}>
        <div className={bodyClassName}>{children}</div>
      </CollapsibleRegion>
    </motion.div>
  );
}

/**
 * 控制器里的一组控件。组标题取全站区块小标题的口径（标题标签、xs 半粗、弱化色，图标 3.5 与文字同色）：
 * 图标只是组的记号，不按氛围着色；中性分组在暗色下也不出现冷色点。
 */
export function TestControlGroup({
  label,
  icon: Icon,
  children,
}: {
  label: string;
  icon: LucideIcon;
  children: ReactNode;
}) {
  return (
    <section>
      <h3 className="mb-1.5 flex items-center gap-1.5 text-xs font-semibold text-muted-foreground">
        <Icon className="h-3.5 w-3.5" aria-hidden="true" />
        {label}
      </h3>
      {children}
    </section>
  );
}

export interface BotCountRowProps {
  count: number;
  onAdd: () => void;
  onRemove: () => void;
  addPending: boolean;
  removePending: boolean;
}

/** 测试人机的加减行：数量居中，两侧按钮等宽，在途的一侧禁用并转圈。 */
export function BotCountRow({
  count,
  onAdd,
  onRemove,
  addPending,
  removePending,
}: BotCountRowProps) {
  return (
    <div className="flex items-center gap-1.5">
      <Button
        variant="outline"
        size="xs"
        className="flex-1 gap-1 px-3"
        aria-label="移除一个测试人机"
        disabled={count === 0 || removePending}
        loading={removePending}
        onClick={onRemove}
      >
        <Minus className="h-3 w-3" />
        减一个
      </Button>
      <span className="w-10 text-center text-sm font-medium tabular-nums">{count}</span>
      <Button
        variant="outline"
        size="xs"
        className="flex-1 gap-1 px-3"
        aria-label="添加一个测试人机"
        disabled={addPending}
        loading={addPending}
        onClick={onAdd}
      >
        <Plus className="h-3 w-3" />
        加一个
      </Button>
    </div>
  );
}
