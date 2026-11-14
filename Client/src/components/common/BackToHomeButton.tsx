import { ArrowLeft } from "lucide-react";
import { Button } from "@/components/ui/Button";

/** 顶栏左端「返回主页」的固定样式。用链接形态的页面自己渲染元素，只取这组类名。 */
export const BACK_TO_HOME_CLASS = "-ml-2 h-8 shrink-0 gap-1.5 px-2 text-muted-foreground";

/** 页面顶栏左端的「返回主页」按钮：样式固定，页面只决定点了之后做什么。 */
export function BackToHomeButton({
  onClick,
  disabled,
}: {
  onClick: () => void;
  disabled?: boolean;
}) {
  return (
    <Button
      variant="ghost"
      size="sm"
      className={BACK_TO_HOME_CLASS}
      disabled={disabled}
      onClick={onClick}
    >
      <ArrowLeft aria-hidden="true" />
      <span>返回主页</span>
    </Button>
  );
}
