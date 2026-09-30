import type { ReactNode } from "react";
import { ArrowLeft, type LucideIcon } from "lucide-react";
import { Button } from "@/components/ui/Button";
import { cn } from "@/lib/Utils";

/** 移动端顶栏入口：各自在对应面板常驻显示的断点以下出现。 */
export interface RoomHeaderToggle {
  key: string;
  icon: LucideIcon;
  label: string;
  expanded: boolean;
  onClick: () => void;
  /** 该入口可见的最大断点：玩家面板 `md` 起常驻，聊天面板 `xl` 起常驻 */
  hideFrom: "md" | "xl";
}

const HIDE_FROM = { md: "md:hidden", xl: "xl:hidden" } as const;

/** 顶栏中间的视角/身份徽章（主持人、出题人视角、旁观等）。 */
export function HeaderChip({ icon: Icon, label, muted = false, title, className }: { icon: LucideIcon; label: string; muted?: boolean; title?: string; className?: string }) {
  return (
    <span
      title={title}
      className={cn(
        "inline-flex shrink-0 items-center gap-1.5 rounded-md bg-muted px-2.5 py-1 text-xs font-semibold",
        muted ? "text-muted-foreground" : "text-foreground",
        className,
      )}
    >
      <Icon className="h-3.5 w-3.5" />
      {label}
    </span>
  );
}

/** 顶栏中间的局数/天数文字。 */
export function HeaderCounter({ children }: { children: ReactNode }) {
  return <span className="shrink-0 whitespace-nowrap text-xs font-semibold text-muted-foreground sm:text-sm">{children}</span>;
}

/**
 * 房间页固定 `h-14` 顶栏，三等分：左侧返回与房间信息，中间局面信息，右侧连接状态与操作入口。
 * 三个游戏共用，布局与断点只在这里维护。
 */
export function RoomHeader({
  onLeave,
  title,
  roomId,
  center,
  actions,
  connectionIssue,
  toggles = [],
}: {
  onLeave: () => void;
  title: string;
  /** 单人模式等没有房号的场景传 undefined */
  roomId?: string;
  center?: ReactNode;
  /** 右侧常驻操作（如音量），放在连接状态之后、移动端入口之前 */
  actions?: ReactNode;
  /** 断线提示文案，例如「断线中...」；为空表示连接正常 */
  connectionIssue?: string | null;
  toggles?: RoomHeaderToggle[];
}) {
  return (
    <header className="grid h-14 shrink-0 grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-1 bg-background px-2 md:grid-cols-3 md:gap-2 md:px-4 lg:px-6">
      <div className="flex min-w-0 items-center gap-2">
        <Button variant="ghost" size="icon" onClick={onLeave} className="shrink-0" aria-label="离开房间">
          <ArrowLeft className="h-5 w-5" />
        </Button>
        <span className="hidden truncate text-base font-semibold md:block">{title}</span>
        {roomId ? <span className="hidden shrink-0 font-mono text-xs text-muted-foreground sm:inline">#{roomId}</span> : null}
      </div>

      <div className="flex min-w-0 items-center justify-center gap-1 overflow-hidden sm:gap-1.5 md:gap-2">{center}</div>

      <div className="flex items-center justify-end gap-0 md:gap-1">
        {connectionIssue ? (
          <span role="status" className="mr-1 hidden shrink-0 text-xs text-destructive motion-safe:animate-pulse sm:inline">
            {connectionIssue}
          </span>
        ) : null}
        {actions}
        {toggles.map(({ key, icon: Icon, label, expanded, onClick, hideFrom }) => (
          <Button
            key={key}
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
