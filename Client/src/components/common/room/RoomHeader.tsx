import type { ReactNode, Ref } from "react";
import { AnimatePresence, motion } from "framer-motion";
import { ArrowLeft, WifiOff, type LucideIcon } from "lucide-react";
import { Badge } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import { Hint } from "@/components/ui/Tooltip";
import { useSharedElementName } from "@/hooks/UsePageTransition";
import { popover } from "@/lib/motion/Choreography";
import { readoutSwap } from "@/lib/motion/NamedMoves";
import { cn } from "@/lib/Utils";

/** 移动端顶栏入口：各自在对应面板常驻显示的断点以下出现。 */
export interface RoomHeaderToggle {
  key: string;
  icon: LucideIcon;
  label: string;
  expanded: boolean;
  onClick: () => void;
  triggerRef?: Ref<HTMLButtonElement>;
  /** 该入口可见的最大断点：玩家面板 `md` 起常驻，聊天面板 `xl` 起常驻 */
  hideFrom: "md" | "xl";
}

const HIDE_FROM = { md: "md:hidden", xl: "xl:hidden" } as const;

/**
 * 顶栏中间的身份徽章（主持人、出题人、旁观等），只写身份名，不加「视角」后缀。
 * 手机宽度下中栏只剩一百来像素，身份徽章只留图标、身份名交给读屏，三款玩法同一种窄屏形态；
 * `truncate` 的徽章（如词语提示）内容本身就是信息，窄屏收起图标、照常显示文字并在放不下时截断，悬停补全文。
 */
export function HeaderChip({
  icon: Icon,
  label,
  muted = false,
  title,
  truncate = false,
  className,
}: {
  icon: LucideIcon;
  label: string;
  muted?: boolean;
  title?: string;
  truncate?: boolean;
  className?: string;
}) {
  // 徽章在中栏放不下时会截断（`truncate`），悬停补全文；不截断则默认不挂浮层。
  return (
    <Hint label={title ?? (truncate ? label : undefined)}>
      <span
        className={cn(
          "inline-flex items-center gap-1.5 rounded-md bg-muted px-2.5 py-1 text-xs font-semibold",
          truncate ? "min-w-0" : "shrink-0 max-sm:px-1.5",
          muted ? "text-muted-foreground" : "text-foreground",
          className
        )}
      >
        {/* 窄屏上截断型徽章把图标的位置让给文字：与停靠在顶栏的词语同一种纯文字小块。 */}
        <Icon className={cn("h-3.5 w-3.5 shrink-0", truncate && "max-sm:hidden")} />
        {truncate ? (
          <span className="min-w-0 truncate">{label}</span>
        ) : (
          <span className="max-sm:sr-only">{label}</span>
        )}
      </span>
    </Hint>
  );
}

/** 顶栏中间的局数/天数文字。`className` 只供调用处在窄屏让位时收起它。 */
export function HeaderCounter({
  children,
  className,
}: {
  children: ReactNode;
  className?: string;
}) {
  return (
    <span
      className={cn(
        "shrink-0 whitespace-nowrap text-xs font-semibold text-muted-foreground sm:text-sm",
        className
      )}
    >
      {children}
    </span>
  );
}

/**
 * 房间页固定 `h-14` 顶栏，三等分：左侧返回与房间信息，中间局面信息，右侧连接状态与操作入口。
 * 三个游戏共用，布局与断点只在这里维护。
 */
export function RoomHeader({
  onLeave,
  leaveRef,
  title,
  roomId,
  roomTag,
  center,
  actions,
  connectionIssue,
  toggles = [],
}: {
  onLeave: () => void;
  leaveRef?: Ref<HTMLButtonElement>;
  title: string;
  /** 单人模式等没有房号的场景传 undefined */
  roomId?: string;
  /** 接在房号后的房间类别（如 CEE 原版房），只标与默认不同的房间 */
  roomTag?: string;
  center?: ReactNode;
  /** 右侧常驻操作（如音量），放在连接状态之后、移动端入口之前 */
  actions?: ReactNode;
  /** 断线提示文案，例如「断线中...」；为空表示连接正常 */
  connectionIssue?: string | null;
  toggles?: RoomHeaderToggle[];
}) {
  // 房名与大厅卡片里的房名是同一个跨页共享元素；房间页本身就是过渡的一端，任何过渡都命名。
  // 单人模式没有对应的大厅卡片，不命名，免得返回主页时房名脱离整页单独淡出。
  const titleName = useSharedElementName("room-title", roomId ? undefined : false);
  return (
    <header
      data-room-part="header"
      className="grid h-14 shrink-0 grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-1 px-2 md:grid-cols-3 md:gap-2 md:px-4 lg:px-6"
    >
      <div className="flex min-w-0 items-center gap-2">
        <Button
          ref={leaveRef}
          variant="ghost"
          size="icon"
          onClick={onLeave}
          className="shrink-0"
          aria-label="离开房间"
        >
          <ArrowLeft className="h-5 w-5" />
        </Button>
        {/* 房名是房间页的标题：读屏与抓取器需要一个 h1，但窄屏顶栏放不下房名，
            所以 h1 视觉隐藏、各宽度都在；看得见的房名只在宽屏出现，并承担跨页共享元素。 */}
        <h1 className="sr-only">{title}</h1>
        <span
          aria-hidden="true"
          className="hidden truncate text-base font-semibold md:block"
          style={{ viewTransitionName: titleName }}
        >
          {title}
        </span>
        {roomId ? (
          <span className="hidden shrink-0 font-mono text-xs text-muted-foreground sm:inline">
            #{roomId}
          </span>
        ) : null}
        {/* 房间类别跟着房号走，与大厅卡片里接在房名后的标签同口径；手机上房号收起，标签仍留着。 */}
        {roomTag ? (
          <Badge variant="subtle" size="xs" className="shrink-0">
            {roomTag}
          </Badge>
        ) : null}
      </div>

      {/* safe 居中：内容比中栏宽时退回左对齐，只裁右侧并由可截断的子项收窄，不会两端一起被裁。 */}
      <div className="flex min-w-0 items-center justify-center-safe gap-1 overflow-hidden sm:gap-1.5 md:gap-2">
        {center}
      </div>

      <div className="flex items-center justify-end gap-0 md:gap-1">
        {/* 断线提示：sm 起写成文字，更窄时收成一枚图标（可访问名即文案），两者都随断线出现、恢复后收起。 */}
        <AnimatePresence initial={false}>
          {connectionIssue ? (
            <motion.span
              key="text"
              variants={readoutSwap}
              initial="initial"
              animate="animate"
              exit="exit"
              role="status"
              className="mr-1 hidden shrink-0 text-xs text-destructive motion-safe:animate-breathe sm:inline"
            >
              {connectionIssue}
            </motion.span>
          ) : null}
          {connectionIssue ? (
            <motion.span
              key="icon"
              variants={popover}
              initial="initial"
              animate="animate"
              exit="exit"
              role="status"
              aria-label={connectionIssue}
              className="mr-1 flex shrink-0 text-destructive sm:hidden"
            >
              <WifiOff className="h-4 w-4" aria-hidden="true" />
              {/* 播报读的是区域里的文字，aria-label 只作可访问名；两者同一份文案。 */}
              <span className="sr-only">{connectionIssue}</span>
            </motion.span>
          ) : null}
        </AnimatePresence>
        {actions}
        {toggles.map(({ key, icon: Icon, label, expanded, onClick, hideFrom, triggerRef }) => (
          <Button
            key={key}
            ref={triggerRef}
            variant="ghost"
            size="icon"
            className={cn("h-9 w-9", HIDE_FROM[hideFrom])}
            aria-label={label}
            aria-expanded={expanded}
            onClick={onClick}
          >
            <Icon className="h-5 w-5" />
          </Button>
        ))}
      </div>
    </header>
  );
}
