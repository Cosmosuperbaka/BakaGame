import { useState } from "react";
import { Lock, UserMinus, X } from "lucide-react";
import type { AdminRoom, RecordedGameKind } from "@/types";
import { Badge } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import { SettingSelect } from "@/components/common/room/SettingFields";
import { AdminToolbar, ConfirmDialog, QueryState } from "@/components/admin/AdminParts";
import { useAdminQuery } from "@/hooks/UseAdminQuery";
import { api, apiErrorMessage } from "@/lib/Api";
import { GAME_LABELS, GAME_OPTIONS, formatShortDateTime } from "@/lib/AdminFormat";

type Pending =
  | { kind: "close"; room: AdminRoom }
  | { kind: "kick"; room: AdminRoom; player: AdminRoom["players"][number] };

const MEMBERSHIP_LABELS: Record<string, string> = { spectator: "旁观", kicked: "已移出" };
const GAME_FILTER = [{ value: "", label: "全部游戏" }, ...GAME_OPTIONS];

function RoomCard({ room, onClose, onKick }: { room: AdminRoom; onClose: () => void; onKick: (player: AdminRoom["players"][number]) => void }) {
  const online = room.players.filter((player) => player.online).length;
  return (
    <li className="rounded-md border bg-card p-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex min-w-0 flex-wrap items-center gap-2">
            <Badge variant="outline" size="xs">{GAME_LABELS[room.game]}</Badge>
            <h3 className="min-w-0 truncate font-semibold">{room.name}</h3>
            {room.hasPassword ? <Lock className="h-3.5 w-3.5 text-muted-foreground" aria-label="有密码" /> : null}
            {room.visibility === "private" ? <Badge variant="subtle" size="xs">私密</Badge> : null}
            {room.hidden ? <Badge variant="upcoming" size="xs">不在大厅</Badge> : null}
          </div>
          <div className="mt-1 text-xs text-muted-foreground">
            <span className="font-mono">{room.roomId}</span> · {room.phase} · 第 {room.roundNumber} 轮 · 在线 {online}/{room.players.length} · 创建 {formatShortDateTime(room.createdAt)} · 活跃 {formatShortDateTime(room.lastActiveAt)}
          </div>
        </div>
        <Button type="button" variant="outline" size="sm" onClick={onClose}>
          <X />
          关闭房间
        </Button>
      </div>
      {room.players.length ? (
        <ul className="mt-3 flex flex-wrap gap-2" aria-label={`${room.name} 的玩家`}>
          {room.players.map((player) => (
            <li key={player.id} className="flex h-8 items-center gap-1.5 rounded-md border bg-background pl-2.5 text-sm">
              <span className={player.online ? "" : "text-muted-foreground"}>{player.name}</span>
              {player.host ? <Badge variant="active" size="xs">房主</Badge> : null}
              {player.bot ? <Badge variant="upcoming" size="xs">机器人</Badge> : null}
              {player.membership !== "active" ? <Badge variant="subtle" size="xs">{MEMBERSHIP_LABELS[player.membership] ?? player.membership}</Badge> : null}
              {player.userId ? <Badge variant="subtle" size="xs">已登录</Badge> : null}
              <Button type="button" variant="ghost" size="icon" className="size-8 text-muted-foreground hover:text-destructive" aria-label={`移出 ${player.name}`} onClick={() => onKick(player)}>
                <UserMinus />
              </Button>
            </li>
          ))}
        </ul>
      ) : null}
    </li>
  );
}

export function RoomsPanel() {
  const [game, setGame] = useState<RecordedGameKind | "">("");
  const [pending, setPending] = useState<Pending | null>(null);
  const rooms = useAdminQuery(`rooms:${game}`, () => api.admin.rooms.list(game ? { game } : {}), "房间列表加载失败");
  const list = rooms.data ?? [];

  const confirm = async () => {
    if (!pending) return null;
    try {
      if (pending.kind === "close") await api.admin.rooms.close({ game: pending.room.game, roomId: pending.room.roomId });
      else await api.admin.rooms.kick({ game: pending.room.game, roomId: pending.room.roomId, playerId: pending.player.id });
      rooms.reload();
      return null;
    } catch (cause) {
      return apiErrorMessage(cause, "操作失败，请稍后重试");
    }
  };

  return (
    <div>
      <AdminToolbar title="实时房间" count={rooms.data ? list.length : null} onReload={rooms.reload} loading={rooms.loading && Boolean(rooms.data)}>
        <div className="w-36"><SettingSelect label="游戏" value={game} options={GAME_FILTER} onChange={(value) => setGame(value as RecordedGameKind | "")} /></div>
      </AdminToolbar>
      <p className="mb-3 text-xs text-muted-foreground">CCB 只列出增强房；原版房在上游服务器，不在此管理。关房与移人都会写入审计。</p>
      <QueryState loading={rooms.loading} error={rooms.error} empty={Boolean(rooms.data) && !list.length} hasData={Boolean(rooms.data)} onRetry={rooms.reload} emptyText="当前没有房间" />
      <ul className="grid gap-3">
        {list.map((room) => (
          <RoomCard
            key={`${room.game}:${room.roomId}`}
            room={room}
            onClose={() => setPending({ kind: "close", room })}
            onKick={(player) => setPending({ kind: "kick", room, player })}
          />
        ))}
      </ul>
      <ConfirmDialog
        open={pending !== null}
        onOpenChange={(open) => { if (!open) setPending(null); }}
        title={pending?.kind === "kick" ? "移出玩家" : "关闭房间"}
        description={pending?.kind === "kick"
          ? `把「${pending.player.name}」移出房间「${pending.room.name}」？`
          : pending ? `关闭「${pending.room.name}」（${GAME_LABELS[pending.room.game]} · ${pending.room.roomId}）？房内玩家会收到房间已关闭的通知。` : ""}
        confirmLabel={pending?.kind === "kick" ? "移出" : "关闭房间"}
        onConfirm={confirm}
      />
    </div>
  );
}
