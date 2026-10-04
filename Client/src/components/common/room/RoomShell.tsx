import { createRef, useEffect, useRef, useState, type ReactNode, type Ref } from "react";
import type { LucideIcon } from "lucide-react";
import { PLAYER_COLUMN_WIDTH } from "@/components/common/PlayerStatusPill";
import { roomEntranceMs } from "@/lib/Motion";
import { cn } from "@/lib/Utils";
import { RoomDrawer } from "./RoomDrawer";
import { RoomHeader } from "./RoomHeader";

/**
 * 移动端覆盖面板的声明。房间页只描述「有哪些面板」，
 * 顶栏入口按钮、抽屉本体与背板由 RoomShell 统一渲染，三个游戏的断点与交互因此保持一致。
 */
export interface RoomDrawerSpec {
  /** 与 openDrawer 对应的标识 */
  key: string;
  icon: LucideIcon;
  /** 顶栏入口按钮的可访问名 */
  label: string;
  side: "left" | "right";
  /** 面板标题，同时是读屏读到面板名称 */
  title: string;
  /** 该面板在此断点及以上常驻显示，覆盖面板自动隐藏 */
  closeFrom: "md" | "xl";
  /** 尺寸类；省略时左侧 `w-72`、右侧 `w-80` */
  className?: string;
  content: ReactNode;
}

/**
 * 左侧玩家栏的桌面外壳：定宽列，与游戏区、聊天栏同一套圆角与边框。
 * `data-room-part` 标记进房编排的一栏；自己拼玩家栏的页面（谁是卧底）在栏本体上写同一标记。
 */
export function PlayerColumn({ width = PLAYER_COLUMN_WIDTH, className, children }: {
  width?: string;
  className?: string;
  children: ReactNode;
}) {
  return (
    <aside
      data-room-part="player"
      className={cn("hidden min-h-0 shrink-0 flex-col overflow-hidden rounded-md border bg-panel md:flex", className)}
      style={{ width }}
    >
      {children}
    </aside>
  );
}

/** 右侧聊天栏的桌面外壳；`xl` 以下由覆盖面板承担，否则与玩家栏同时常驻会把游戏区挤得过窄。 */
export function ChatColumn({ className, children }: { className?: string; children: ReactNode }) {
  return (
    <aside data-room-part="chat" className={cn("hidden min-h-0 w-80 shrink-0 flex-col overflow-hidden rounded-md border bg-panel xl:flex", className)}>
      {children}
    </aside>
  );
}

/**
 * 三游戏共用的房间页骨架：固定 `h-14` 顶栏 + 三栏主体（玩家栏、游戏区、聊天栏）+ 覆盖面板。
 *
 * 主体宽度、断点与内边距只在这里维护；各游戏传入自己的栏内容与游戏区。
 * 玩家栏与聊天栏在断点以下折叠为覆盖面板，抽屉渲染在主体容器内（不用 Portal），
 * 因此顶栏的离开按钮始终可点。
 */
export function RoomShell({
  before,
  onLeave,
  title,
  roomId,
  roomTag,
  center,
  actions,
  connectionIssue,
  player,
  game,
  gameRef,
  chat,
  drawers = [],
  openDrawer = null,
  onDrawerChange,
}: {
  /** 页面级不可见节点（Seo、audio 等），渲染在最外层容器里 */
  before?: ReactNode;
  onLeave: () => void;
  title: string;
  roomId?: string;
  /** 接在房号后的房间类别标签，见 RoomHeader */
  roomTag?: string;
  /** 顶栏中间的徽章槽（局数、身份、视角） */
  center?: ReactNode;
  /** 顶栏右侧常驻操作（音量等），位于连接状态之后 */
  actions?: ReactNode;
  /** 断线提示文案；为空表示连接正常 */
  connectionIssue?: string | null;
  /** 左侧玩家栏（桌面），通常用 PlayerColumn */
  player?: ReactNode;
  /** 游戏区内容，由 RoomShell 套上统一的外框 */
  game: ReactNode;
  /** 游戏区外框的引用，供页面定位区内浮层（如揭词背板） */
  gameRef?: Ref<HTMLElement>;
  /** 右侧聊天栏（桌面），通常用 ChatColumn */
  chat?: ReactNode;
  drawers?: RoomDrawerSpec[];
  openDrawer?: string | null;
  onDrawerChange?: (key: string | null) => void;
}) {
  const leaveRef = useRef<HTMLButtonElement>(null);
  const [triggerRefs] = useState(() => new Map<string, ReturnType<typeof createRef<HTMLButtonElement>>>());
  for (const drawer of drawers) {
    if (!triggerRefs.has(drawer.key)) triggerRefs.set(drawer.key, createRef<HTMLButtonElement>());
  }
  const opened = drawers.find((drawer) => drawer.key === openDrawer) ?? null;

  // 进房编排只在房间页挂载后的一小段窗口里打开：窗口内挂载的栏依次就位（index.css 的 data-room-entering）；
  // 断线重连时房间页不重新挂载，之后补上的栏直接出现，不重播。
  // 窗口从挂载后的第一帧算起：跨页过渡会暂停渲染直到新页就绪，CSS 动画也是那一帧才起播，从挂载就计时会让窗口早于各栏动画收尾。
  const [entering, setEntering] = useState(true);
  useEffect(() => {
    let timer: number | undefined;
    const frame = window.requestAnimationFrame(() => {
      timer = window.setTimeout(() => setEntering(false), roomEntranceMs);
    });
    return () => {
      window.cancelAnimationFrame(frame);
      window.clearTimeout(timer);
    };
  }, []);

  return (
    <div data-room-entering={entering || undefined} className="flex h-full min-h-0 flex-col overflow-hidden">
      {before}
      <RoomHeader
        onLeave={onLeave}
        leaveRef={leaveRef}
        title={title}
        roomId={roomId}
        roomTag={roomTag}
        center={center}
        actions={actions}
        connectionIssue={connectionIssue}
        toggles={drawers.map((drawer) => ({
          key: drawer.key,
          triggerRef: triggerRefs.get(drawer.key),
          icon: drawer.icon,
          label: drawer.label,
          expanded: openDrawer === drawer.key,
          onClick: () => onDrawerChange?.(openDrawer === drawer.key ? null : drawer.key),
          hideFrom: drawer.closeFrom,
        }))}
      />

      <div className="relative flex min-h-0 flex-1 gap-2 overflow-hidden px-2 pb-2 md:gap-3 md:px-3 md:pb-3">
        <section className="relative flex min-h-0 min-w-0 flex-1 gap-2 overflow-hidden md:gap-3">
          {player}
          {/* `isolate` 使游戏区内的浮层只在游戏区内部层级，不会越过玩家面板去盖住骑缝的展开按钮。 */}
          <main ref={gameRef} data-room-part="game" className="isolate flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden rounded-md border bg-panel">
            {game}
          </main>
        </section>
        {chat}

        {opened ? (
          <RoomDrawer
            key={opened.key}
            triggerRef={triggerRefs.get(opened.key)}
            fallbackFocusRef={leaveRef}
            open
            side={opened.side}
            title={opened.title}
            closeFrom={opened.closeFrom}
            className={opened.className}
            onOpenChange={(next) => { if (!next) onDrawerChange?.(null); }}
          >
            {opened.content}
          </RoomDrawer>
        ) : null}
      </div>
    </div>
  );
}
