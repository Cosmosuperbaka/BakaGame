import type { ReactNode } from "react";
import { useNavigate } from "react-router-dom";
import { AnimatePresence, motion } from "framer-motion";
import { ArrowLeft, Plus } from "lucide-react";
import { Button } from "@/components/ui/Button";
import { Input } from "@/components/ui/Input";
import { Seo } from "@/components/common/Seo";
import { RoomCardSkeleton } from "@/components/common/RoomCardSkeleton";
import { listContainer, spring } from "@/lib/Motion";
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
  onCreate,
  onSelectRoom,
  children,
  dialogs,
  disabled = false,
}: LobbyPageProps) {
  const navigate = useNavigate();
  return (
    <motion.div
      initial={{ opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      transition={spring.swift}
      className="scrollbar-hidden flex h-full min-h-0 flex-col overflow-x-hidden overflow-y-auto bg-background"
    >
      <Seo path={path} />
      <header className="border-b border-border/40 px-6 pb-4 pt-6 md:pt-8">
        <div className="mx-auto flex max-w-3xl items-center gap-3">
          <Button variant="ghost" size="sm" className="-ml-2 h-8 gap-1.5 px-2 text-muted-foreground" onClick={() => navigate("/")}>
            <ArrowLeft className="h-4 w-4" />
            <span>返回主页</span>
          </Button>
          <div className="h-4 w-px bg-border/60" />
          <h1 className="flex items-center gap-2 text-xl font-bold tracking-tight sm:text-2xl">
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
              maxLength={20}
            />
            <Button size="sm" onClick={onCreate} disabled={disabled} className="shrink-0 gap-1.5 text-sm shadow-2xs">
              <Plus className="h-3.5 w-3.5" />
              创建房间
            </Button>
          </div>
        </div>

        {children}

        <motion.div className="flex flex-col gap-3" variants={listContainer(rooms.length)} initial="initial" animate="animate">
          <AnimatePresence initial={false}>
            {loading ? (
              <RoomCardSkeleton count={3} />
            ) : rooms.length === 0 ? (
              <RoomListEmpty key="empty" />
            ) : (
              rooms.map((room) => (
                <RoomListCard key={`${room.tag ?? ""}:${room.roomId}`} room={room} disabled={disabled} onSelect={(event) => onSelectRoom(room, event)} />
              ))
            )}
          </AnimatePresence>
        </motion.div>
      </main>

      {dialogs}
    </motion.div>
  );
}
