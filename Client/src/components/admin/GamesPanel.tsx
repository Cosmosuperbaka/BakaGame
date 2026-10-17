import { useState } from "react";
import type { GameRecordDetail, RecordedGameKind } from "@/types";
import { Badge } from "@/components/ui/Badge";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/Dialog";
import { Hint } from "@/components/ui/Tooltip";
import { SettingSelect, SettingTextField } from "@/components/common/room/SettingFields";
import { AdminTable, AdminToolbar, Pager, QueryState, RowButton } from "@/components/admin/AdminParts";
import { useAdminQuery } from "@/hooks/UseAdminQuery";
import { api } from "@/lib/Api";
import { GAME_LABELS, GAME_OPTIONS, formatDateTime, formatDuration, formatShortDateTime } from "@/lib/AdminFormat";

const LIMIT = 20;
const GAME_FILTER = [{ value: "", label: "全部游戏" }, ...GAME_OPTIONS];

/** 时间线时刻写成距开局的「分:秒」。 */
const offsetOf = (at: number, startedAt: string) => {
  const seconds = Math.max(0, Math.round((at - Date.parse(startedAt)) / 1000));
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
};

const signed = (score: number) => `${score > 0 ? "+" : ""}${score}`;

function GameDetail({ record }: { record: GameRecordDetail }) {
  const players = [...record.players].sort((a, b) => b.score - a.score);
  return (
    <div className="grid gap-4">
      <div className="text-sm text-muted-foreground">
        {formatDateTime(record.startedAt)} 创建 · 历时 {formatDuration(record.startedAt, record.endedAt)} · 共 {record.roundCount} 回合
      </div>
      <AdminTable label="玩家" className="shadow-none [&_table]:min-w-0">
        <thead><tr><th scope="col">玩家</th><th scope="col">账号</th><th scope="col" className="text-right!">本局总分</th></tr></thead>
        <tbody>
          {players.map((player) => (
            <tr key={player.playerId}>
              <th scope="row" className="font-normal! text-foreground!">{player.name}</th>
              <td className="font-mono text-xs text-muted-foreground">{player.userId ?? "游客"}</td>
              <td className="text-right tabular-nums">{player.score}</td>
            </tr>
          ))}
        </tbody>
      </AdminTable>
      <section aria-labelledby="game-rounds" className="grid gap-2">
        <h3 id="game-rounds" className="text-sm font-semibold">回合（{record.rounds.length}）</h3>
        {record.rounds.length ? (
          <div className="grid max-h-80 gap-2 overflow-y-auto">
            {record.rounds.map((round) => (
              <details key={round.number} className="rounded-md border bg-card p-3">
                <summary className="cursor-pointer text-sm">
                  第 {round.number} 回合 · {formatShortDateTime(round.startedAt)} · 历时 {formatDuration(round.startedAt, round.endedAt)}
                </summary>
                <div className="mt-2 grid gap-2">
                  {round.players.length ? (
                    <p className="text-xs text-muted-foreground">
                      本回合得分：{round.players.map((player) => `${player.name} ${signed(player.score)}`).join(" · ")}
                    </p>
                  ) : null}
                  <pre className="max-h-60 overflow-auto rounded-md border bg-muted/40 p-3 font-mono text-xs whitespace-pre-wrap break-all">{JSON.stringify(round.summary, null, 2)}</pre>
                </div>
              </details>
            ))}
          </div>
        ) : <p className="text-sm text-muted-foreground">没有回合记录</p>}
      </section>
      <section aria-labelledby="game-timeline" className="grid gap-2">
        <h3 id="game-timeline" className="text-sm font-semibold">关键事件（{record.timeline.length}）</h3>
        {record.timeline.length ? (
          <ol className="grid max-h-72 gap-1 overflow-y-auto rounded-md border bg-card p-3 font-mono text-xs">
            {record.timeline.map((event, index) => {
              const { at, type, round, ...rest } = event;
              return (
                <li key={index} className="grid grid-cols-[3rem_3.5rem_7rem_minmax(0,1fr)] gap-2">
                  <span className="tabular-nums text-muted-foreground">{offsetOf(at, record.startedAt)}</span>
                  <span className="tabular-nums text-muted-foreground">第 {String(round)} 回合</span>
                  <span className="truncate">{type}</span>
                  <span className="break-all text-muted-foreground">{Object.keys(rest).length ? JSON.stringify(rest) : ""}</span>
                </li>
              );
            })}
          </ol>
        ) : <p className="text-sm text-muted-foreground">没有记录事件</p>}
      </section>
    </div>
  );
}

function GameLoader({ id }: { id: string }) {
  const query = useAdminQuery(`game:${id}`, () => api.admin.games.get({ id }), "对局详情加载失败");
  return (
    <>
      <QueryState loading={query.loading} error={query.error} empty={false} hasData={Boolean(query.data)} onRetry={query.reload} emptyText="" />
      {query.data ? <GameDetail record={query.data} /> : null}
    </>
  );
}

export function GamesPanel() {
  const [game, setGame] = useState("");
  const [roomId, setRoomId] = useState("");
  const [offset, setOffset] = useState(0);
  const [open, setOpen] = useState<{ id: string; game: RecordedGameKind; roomId: string; roundCount: number } | null>(null);
  const room = roomId.trim();
  const input = { ...(game ? { game: game as RecordedGameKind } : {}), ...(room ? { roomId: room } : {}), limit: LIMIT, offset };
  const list = useAdminQuery(`games:${JSON.stringify(input)}`, () => api.admin.games.list(input), "对局记录加载失败");
  const items = list.data?.items ?? [];

  return (
    <div>
      <AdminToolbar title="对局记录" count={list.data?.total ?? null} onReload={list.reload} loading={list.loading && Boolean(list.data)}>
        <div className="w-36"><SettingSelect label="游戏" value={game} options={GAME_FILTER} onChange={(value) => { setGame(value); setOffset(0); }} /></div>
        <div className="w-36"><SettingTextField label="房间号" value={roomId} onChange={(value) => { setRoomId(value.slice(0, 32)); setOffset(0); }} placeholder="完整房间号" /></div>
      </AdminToolbar>
      <p className="mb-3 text-xs text-muted-foreground">对局记录永久保留；一局 = 一个房间从创建到销毁。</p>
      <QueryState loading={list.loading} error={list.error} empty={Boolean(list.data) && !items.length} hasData={Boolean(list.data)} onRetry={list.reload} emptyText="没有符合条件的对局" />
      {items.length ? (
        <AdminTable label="对局列表">
          <thead><tr><th scope="col">房间</th><th scope="col">游戏</th><th scope="col">玩家</th><th scope="col">结束时间</th><th scope="col">时长</th></tr></thead>
          <tbody>
            {items.map((item) => (
              <tr key={item.id}>
                <td><RowButton onClick={() => setOpen(item)}><span className="font-mono">{item.roomId}</span> · {item.roundCount} 回合</RowButton></td>
                <td><Badge variant="outline" size="xs">{GAME_LABELS[item.game]}</Badge></td>
                <Hint label={item.players.map((player) => player.name).join("、")}>
                  <td className="max-w-64 truncate text-muted-foreground">
                    {item.players.length} 人 · {item.players.map((player) => player.name).join("、")}
                  </td>
                </Hint>
                <td className="whitespace-nowrap tabular-nums text-muted-foreground">{formatShortDateTime(item.endedAt)}</td>
                <td className="whitespace-nowrap tabular-nums text-muted-foreground">{formatDuration(item.startedAt, item.endedAt)}</td>
              </tr>
            ))}
          </tbody>
        </AdminTable>
      ) : null}
      <Pager offset={offset} limit={LIMIT} total={list.data?.total ?? 0} onChange={setOffset} />
      <Dialog open={open !== null} onOpenChange={(next) => { if (!next) setOpen(null); }}>
        <DialogContent className="sm:max-w-2xl">
          <DialogHeader>
            <DialogTitle>{open ? `${GAME_LABELS[open.game]} · ${open.roomId} · ${open.roundCount} 回合` : "对局详情"}</DialogTitle>
            <DialogDescription>一局（房间）的回合摘要与全房关键事件时间线；不含歌词、音频与头像等大字段。</DialogDescription>
          </DialogHeader>
          {open ? <GameLoader key={open.id} id={open.id} /> : null}
        </DialogContent>
      </Dialog>
    </div>
  );
}
