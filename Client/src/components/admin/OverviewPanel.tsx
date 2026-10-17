import { useState } from "react";
import { ExternalLink } from "lucide-react";
import type { AdminOverview, FeedbackStatus, RecordedGameKind, SentryOverview } from "@/types";
import { Badge } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import { SegmentedControl } from "@/components/ui/SegmentedControl";
import { Hint } from "@/components/ui/Tooltip";
import { AdminTable, AdminToolbar, QueryState } from "@/components/admin/AdminParts";
import { useAdminQuery } from "@/hooks/UseAdminQuery";
import { api } from "@/lib/Api";
import { GAME_LABELS, GAME_OPTIONS, formatDayKey, formatMs, formatNumber, formatShortDateTime } from "@/lib/AdminFormat";
import { FEEDBACK_STATUS_LABELS } from "@/lib/FeedbackLabels";

const DAY_OPTIONS = [
  { value: "7", label: "7 天" },
  { value: "14", label: "14 天" },
  { value: "30", label: "30 天" },
];
const FEEDBACK_ORDER: FeedbackStatus[] = ["open", "processing", "resolved", "closed"];
const GAMES = GAME_OPTIONS.map((option) => option.value);
const sumRounds = (rounds: Record<RecordedGameKind, number>) => GAMES.reduce((total, game) => total + rounds[game], 0);

function Stat({ label, value, detail }: { label: string; value: number; detail?: string }) {
  return (
    <div className="rounded-md border bg-card p-3">
      <div className="text-xs text-muted-foreground">{label}</div>
      <div className="mt-1 text-2xl font-semibold tabular-nums">{formatNumber(value)}</div>
      {detail ? <div className="mt-0.5 text-xs text-muted-foreground">{detail}</div> : null}
    </div>
  );
}

function OverviewStats({ data }: { data: AdminOverview }) {
  const live = GAMES.reduce((total, game) => ({ rooms: total.rooms + data.live[game].rooms, players: total.players + data.live[game].onlinePlayers }), { rooms: 0, players: 0 });
  return (
    <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
      <Stat label="注册账号" value={data.users.total} detail={`今日新增 ${formatNumber(data.users.newToday)} · 管理员 ${data.users.admins} · 封禁 ${data.users.banned}`} />
      <Stat label="待处理反馈" value={data.feedback.open ?? 0} detail={FEEDBACK_ORDER.slice(1).map((status) => `${FEEDBACK_STATUS_LABELS[status]} ${data.feedback[status] ?? 0}`).join(" · ")} />
      <Stat label="实时房间" value={live.rooms} detail={GAMES.map((game) => `${GAME_LABELS[game]} ${data.live[game].rooms}`).join(" · ")} />
      <Stat label="在线玩家" value={live.players} detail={GAMES.map((game) => `${GAME_LABELS[game]} ${data.live[game].onlinePlayers}`).join(" · ")} />
    </div>
  );
}

function DailyTable({ data }: { data: AdminOverview }) {
  const rows = [...data.daily].reverse();
  return (
    <AdminTable label="每日数据">
      <thead>
        <tr>
          <th scope="col">日期</th>
          <th scope="col" className="text-right!">访客</th>
          <th scope="col" className="text-right!">登录访客</th>
          <th scope="col" className="text-right!">浏览</th>
          <th scope="col" className="text-right!">新注册</th>
          <th scope="col" className="text-right!">对局</th>
          <th scope="col" className="text-right!">参与人次</th>
        </tr>
      </thead>
      <tbody className="tabular-nums">
        {rows.map((day, index) => {
          // 超出对局记录保留期的日子没有对局数据，写「—」而不是 0。
          const recorded = index < data.gameRecordDays;
          return (
            <tr key={day.day}>
              <th scope="row" className="font-mono font-normal! text-foreground!">{formatDayKey(day.day)}</th>
              <td className="text-right">{formatNumber(day.visitors)}</td>
              <td className="text-right">{formatNumber(day.signedInVisitors)}</td>
              <td className="text-right">{formatNumber(day.views)}</td>
              <td className="text-right">{formatNumber(day.newUsers)}</td>
              {/* 单元格只写总对局数，悬停给出各游戏的分项，省掉三列占宽 */}
              <Hint label={recorded ? GAMES.map((game) => `${GAME_LABELS[game]} ${day.rounds[game]}`).join(" · ") : undefined}>
                <td className="text-right">
                  {recorded ? formatNumber(sumRounds(day.rounds)) : "—"}
                </td>
              </Hint>
              <td className="text-right">{recorded ? formatNumber(day.roundPlayers) : "—"}</td>
            </tr>
          );
        })}
      </tbody>
    </AdminTable>
  );
}

function PageViews({ data }: { data: AdminOverview }) {
  if (!data.pages.length) return <p className="text-sm text-muted-foreground">所选时段内没有浏览记录</p>;
  const max = Math.max(...data.pages.map((page) => page.views));
  return (
    <ol className="grid gap-2 text-sm">
      {data.pages.map((page) => (
        <li key={page.path} className="grid grid-cols-[minmax(0,10rem)_minmax(0,1fr)_auto] items-center gap-3">
          <span className="truncate font-mono text-xs">{page.path}</span>
          <span className="h-2 rounded-full bg-muted" aria-hidden="true">
            <span className="block h-2 rounded-full bg-primary/60" style={{ width: `${Math.max(2, (page.views / max) * 100)}%` }} />
          </span>
          <span className="tabular-nums text-muted-foreground">{formatNumber(page.views)}</span>
        </li>
      ))}
    </ol>
  );
}

function SentryCard({ data, loading, onReload }: { data: SentryOverview | null; loading: boolean; onReload: () => void }) {
  return (
    <section aria-labelledby="admin-sentry" className="rounded-md border bg-card p-4">
      <div className="mb-3 flex items-center justify-between gap-3">
        <h3 id="admin-sentry" className="font-semibold">错误与性能（近 24 小时）</h3>
        <Button type="button" variant="ghost" size="sm" loading={loading} onClick={onReload}>刷新</Button>
      </div>
      {!data ? (
        <p className="text-sm text-muted-foreground">{loading ? "正在查询 Sentry" : "Sentry 查询失败"}</p>
      ) : !data.configured ? (
        <p className="text-sm text-muted-foreground">服务端未配置 SENTRY_API_TOKEN，暂不展示错误与性能数据。</p>
      ) : (
        <div className="grid gap-4">
          <div className="flex flex-wrap gap-6 text-sm">
            <span>错误事件 <strong className="tabular-nums">{formatNumber(data.errors24h)}</strong></span>
            <span>未解决问题 <strong className="tabular-nums">{formatNumber(data.unresolvedIssues)}</strong></span>
            {data.fetchedAt ? <span className="text-muted-foreground">查询于 {formatShortDateTime(data.fetchedAt)}</span> : null}
          </div>
          {data.warnings.map((warning) => <p key={warning} className="text-xs text-warning">{warning}</p>)}
          {data.issues.length ? (
            <ul className="grid gap-2 text-sm">
              {data.issues.map((issue) => (
                <li key={issue.id} className="flex min-w-0 items-start gap-2">
                  <Badge variant={issue.level === "error" || issue.level === "fatal" ? "restricted" : "subtle"} size="xs" className="mt-0.5 shrink-0">{issue.level}</Badge>
                  <span className="min-w-0 flex-1">
                    {issue.permalink ? (
                      <a href={issue.permalink} target="_blank" rel="noreferrer" className="group inline-flex max-w-full items-center gap-1 underline-offset-4 hover:underline">
                        <span className="truncate">{issue.title}</span>
                        <ExternalLink
                          className="h-3 w-3 shrink-0 opacity-40 transition group-hover:translate-x-0.5 group-hover:-translate-y-0.5 group-hover:opacity-100"
                          aria-hidden="true"
                        />
                      </a>
                    ) : <span className="block truncate">{issue.title}</span>}
                    <span className="block truncate text-xs text-muted-foreground">{issue.shortId} · {issue.count} 次 · {issue.userCount} 人 · 最近 {formatShortDateTime(issue.lastSeen)}</span>
                  </span>
                </li>
              ))}
            </ul>
          ) : <p className="text-sm text-muted-foreground">没有未解决的问题</p>}
          {data.transactions?.length ? (
            <AdminTable label="接口耗时" className="shadow-none">
              <thead><tr><th scope="col">事务</th><th scope="col" className="text-right!">次数</th><th scope="col" className="text-right!">p75</th><th scope="col" className="text-right!">p95</th></tr></thead>
              <tbody className="tabular-nums">
                {data.transactions.map((item) => (
                  <tr key={`${item.project}:${item.name}`}>
                    <td className="max-w-80 truncate font-mono text-xs">{item.name}</td>
                    <td className="text-right">{formatNumber(item.count)}</td>
                    <td className="text-right">{formatMs(item.p75)}</td>
                    <td className="text-right">{formatMs(item.p95)}</td>
                  </tr>
                ))}
              </tbody>
            </AdminTable>
          ) : null}
        </div>
      )}
    </section>
  );
}

export function OverviewPanel() {
  const [days, setDays] = useState("14");
  const overview = useAdminQuery(`overview:${days}`, () => api.admin.stats.overview({ days: Number(days) }), "概览加载失败");
  const sentry = useAdminQuery("sentry", () => api.admin.stats.sentry(), "Sentry 查询失败");
  const data = overview.data;
  return (
    <div className="grid gap-6">
      <div>
        <AdminToolbar title="站点概览" onReload={overview.reload} loading={overview.loading && Boolean(data)}>
          <SegmentedControl aria-label="统计天数" size="sm" value={days} onValueChange={setDays} options={DAY_OPTIONS} />
        </AdminToolbar>
        <QueryState loading={overview.loading} error={overview.error} empty={false} hasData={Boolean(data)} onRetry={overview.reload} emptyText="" />
        {data ? <OverviewStats data={data} /> : null}
      </div>
      {data ? (
        <section aria-labelledby="admin-daily" className="grid gap-3">
          <h3 id="admin-daily" className="font-semibold">每日数据</h3>
          <DailyTable data={data} />
          <p className="text-xs text-muted-foreground">按北京时间自然日统计；对局记录只保留 {data.gameRecordDays} 天，更早的对局数不可查。</p>
        </section>
      ) : null}
      {data ? (
        <section aria-labelledby="admin-pages" className="grid gap-3">
          <h3 id="admin-pages" className="font-semibold">板块浏览</h3>
          <PageViews data={data} />
        </section>
      ) : null}
      <SentryCard data={sentry.data} loading={sentry.loading} onReload={sentry.reload} />
    </div>
  );
}
