import type { ReactNode } from "react";
import { AnimatePresence, motion } from "framer-motion";
import { ArrowLeft, Plus } from "lucide-react";
import { Button } from "@/components/ui/Button";
import { Input } from "@/components/ui/Input";
import { Seo } from "@/components/common/Seo";
import { RoomCardSkeleton } from "@/components/common/RoomCardSkeleton";
import { usePageNavigate, usePageTransitionEnds, useSharedElementName } from "@/hooks/UsePageTransition";
import { duration, ease, listContainer, skeletonFade } from "@/lib/Motion";
import { RoomListCard, type LobbyRoomView } from "./RoomListCard";
import { RoomListEmpty } from "./RoomListEmpty";

export interface LobbyPageProps {
  /** 页面 SEO 路径，例如 `/ccb`。 */
  path: string;
  /** 游戏标识，显示在顶栏分隔线之后。 */
  title: ReactNode;
  /** 房名左侧的游戏图标。 */
  logo?: { src: string; alt: string };
  rooms: LobbyRoomView[];
  /** 首次握手尚未完成：显示骨架屏而不是「暂无房间」。 */
  loading: boolean;
  userName: string;
  onUserNameChange: (value: string) => void;
  /** 用户名输入上限，与该游戏服务端协议一致；默认 20。 */
  nameMaxLength?: number;
  onCreate: (event: React.MouseEvent<HTMLElement>) => void;
  onSelectRoom: (room: LobbyRoomView, event: React.MouseEvent<HTMLElement>) => void;
  /** 列表上方的附加内容（说明文案、服务器分段等）。 */
  children?: ReactNode;
  /** 页面级浮层：创建房间与密码弹窗。 */
  dialogs?: ReactNode;
  /** 有操作在途（例如正在退房）时禁用创建与加入。 */
  disabled?: boolean;
}

/**
 * 三游戏共用的大厅外壳：顶栏（返回主页、游戏标识）、房间列表标题与计数、
 * 用户名与创建按钮，以及列表本身。各游戏只提供房间的展示模型与操作回调。
 */
export function LobbyPage({
  path,
  title,
  logo,
  rooms,
  loading,
  userName,
  onUserNameChange,
  nameMaxLength = 20,
  onCreate,
  onSelectRoom,
  children,
  dialogs,
  disabled = false,
}: LobbyPageProps) {
  const navigate = usePageNavigate();
  // 经页面过渡到达时整页的显影已由过渡快照完成，再淡入一遍会让新页晚到、发虚；直接打开链接时才自己显影。
  const arriving = usePageTransitionEnds() !== null;
  // 游戏名与主页卡片标题是同一个跨页共享元素，只在与主页互相过渡时命名。
  const titleName = useSharedElementName("game-title", "/");
  return (
    // 整页只做显影，不带纵向位移（Animation §2.2）；列表项的入场由 listItem 负责。
    <motion.div
      initial={arriving ? false : { opacity: 0 }}
      animate={{ opacity: 1 }}
      transition={{ duration: duration.base, ease: ease.out }}
      className="scrollbar-hidden flex h-full min-h-0 flex-col overflow-x-hidden overflow-y-auto"
    >
      <Seo path={path} />
      <header className="border-b border-border/40 px-6 pb-4 pt-6 md:pt-8">
        <div className="mx-auto flex max-w-3xl items-center gap-3">
          <Button variant="ghost" size="sm" className="-ml-2 h-8 gap-1.5 px-2 text-muted-foreground" onClick={() => navigate("/")}>
            <ArrowLeft className="h-4 w-4" />
            <span>返回主页</span>
          </Button>
          <div className="h-4 w-px bg-border/60" />
          <h1 className="flex items-center gap-2 text-xl font-bold tracking-tight sm:text-2xl" style={{ viewTransitionName: titleName }}>
            <span>{title}</span>
            {logo ? (
              <img
                src={logo.src}
                alt={logo.alt}
                className="h-6 w-6 rounded-md border border-border/60 object-cover shadow-2xs sm:h-7 sm:w-7"
              />
            ) : null}
          </h1>
        </div>
      </header>

      <main className="mx-auto w-full max-w-3xl flex-1 px-6 pb-10 pt-6 md:px-10">
        {/* 窄屏分两行：标题与计数在上，用户名与创建按钮占满下一行；`sm` 起并成一行。 */}
        <div className="mb-4 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <div className="flex items-center gap-2">
            <h2 className="text-lg font-semibold tracking-tight">房间列表</h2>
            <span className="rounded-md bg-muted px-2 py-0.5 font-mono text-xs text-muted-foreground">{rooms.length}</span>
          </div>
          <div className="flex items-center gap-2.5">
            <Input
              value={userName}
              onChange={(event) => onUserNameChange(event.target.value)}
              placeholder="输入用户名"
              className="h-8 min-w-0 flex-1 border-border/70 bg-card shadow-2xs sm:w-36 sm:flex-none"
              maxLength={nameMaxLength}
            />
            <Button size="sm" onClick={onCreate} disabled={disabled} className="shrink-0 gap-1.5 text-sm shadow-2xs">
              <Plus className="h-3.5 w-3.5" />
              创建房间
            </Button>
          </div>
        </div>

        {children}

        {/* 骨架与列表叠在同一格：数据到达时骨架原地淡出，房间卡片在骨架卡片的位置上推出来（两者共用 RoomCardLayout，高度一致），
            不是先清空再出现。列表后渲染、叠在骨架之上，淡出期间的点击都落在真实卡片上。
            列宽固定为 minmax(0,1fr)：隐式的 auto 列会被卡片的最小内容宽撑开，窄屏上整列比容器还宽。 */}
        <div className="grid grid-cols-1">
          <AnimatePresence initial={false}>
            {loading ? (
              <motion.div key="skeleton" className="[grid-area:1/1]" {...skeletonFade}>
                <RoomCardSkeleton count={3} />
              </motion.div>
            ) : null}
          </AnimatePresence>
          <motion.div className="flex flex-col gap-3 [grid-area:1/1]" variants={listContainer(rooms.length)} initial="initial" animate="animate">
            <AnimatePresence initial={false}>
              {loading ? null : rooms.length === 0 ? (
                <RoomListEmpty key="empty" />
              ) : (
                rooms.map((room) => (
                  <RoomListCard
                    key={`${room.tag ?? ""}:${room.roomId}`}
                    room={room}
                    roomPath={`${path}/room/${encodeURIComponent(room.roomId)}`}
                    disabled={disabled}
                    onSelect={(event) => onSelectRoom(room, event)}
                  />
                ))
              )}
            </AnimatePresence>
          </motion.div>
        </div>
      </main>

      {dialogs}
    </motion.div>
  );
}
