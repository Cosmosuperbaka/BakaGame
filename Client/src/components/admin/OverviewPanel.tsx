import { useState } from "react";
import { useSearchParams } from "react-router-dom";
import { ExternalLink } from "lucide-react";
import type {
  AdminOverview,
  FeedbackStatus,
  RecordedGameKind,
  SentryOverview,
} from "@bakagame/shared";
import { Badge } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import { SegmentedControl } from "@/components/ui/SegmentedControl";
import { Hint } from "@/components/ui/Tooltip";
import { AdminTable, AdminToolbar, QueryState } from "@/components/admin/AdminParts";
import { useAdminQuery } from "@/hooks/UseAdminQuery";
import { api } from "@/lib/Api";
import {
  GAME_LABELS,
  GAME_OPTIONS,
  formatDayKey,
  formatMs,
  formatNumber,
  formatShortDateTime,
} from "@/lib/AdminFormat";
import { FEEDBACK_STATUS_LABELS } from "@/lib/FeedbackLabels";

const DAY_OPTIONS = [
  { value: "7", label: "7 天" },
  { value: "14", label: "14 天" },
  { value: "30", label: "30 天" },
];
const FEEDBACK_ORDER: FeedbackStatus[] = ["open", "processing", "resolved", "closed"];
const GAMES = GAME_OPTIONS.map((option) => option.value);
const sumGames = (games: Record<RecordedGameKind, number>) =>
  GAMES.reduce((total, game) => total + games[game], 0);

function Stat({ label, value, detail }: { label: string; value: number; detail?: string }) {
  return (
    <div className="rounded-md border bg-card p-3">
      <div className="text-xs font-serif text-muted-foreground">{label}</div>
      <div className="mt-1 font-serif text-2xl font-semibold tabular-nums">
        {formatNumber(value)}
      </div>
      {detail ? <div className="mt-0.5 text-xs text-muted-foreground">{detail}</div> : null}
    </div>
  );
}

function OverviewStats({ data }: { data: AdminOverview }) {
  const live = GAMES.reduce(
    (total, game) => ({
      rooms: total.rooms + data.live[game].rooms,
      players: total.players + data.live[game].onlinePlayers,
    }),
    { rooms: 0, players: 0 }
  );
  return (
    <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
      <Stat
        label="注册账号"
        value={data.users.total}
        detail={`今日新增 ${formatNumber(data.users.newToday)} · 管理员 ${data.users.admins} · 封禁 ${data.users.banned}`}
      />
      <Stat
        label="待处理反馈"
        value={data.feedback.open ?? 0}
        detail={FEEDBACK_ORDER.slice(1)
          .map((status) => `${FEEDBACK_STATUS_LABELS[status]} ${data.feedback[status] ?? 0}`)
          .join(" · ")}
      />
      <Stat
        label="实时房间"
        value={live.rooms}
        detail={GAMES.map((game) => `${GAME_LABELS[game]} ${data.live[game].rooms}`).join(" · ")}
      />
      <Stat
        label="在线玩家"
        value={live.players}
        detail={GAMES.map((game) => `${GAME_LABELS[game]} ${data.live[game].onlinePlayers}`).join(
          " · "
        )}
      />
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
          <th scope="col" className="text-right!">
            访客
          </th>
          <th scope="col" className="text-right!">
            登录访客
          </th>
          <th scope="col" className="text-right!">
            浏览
          </th>
          <th scope="col" className="text-right!">
            新注册
          </th>
          <th scope="col" className="text-right!">
            对局
          </th>
          <th scope="col" className="text-right!">
            参与人次
          </th>
        </tr>
      </thead>
      <tbody className="tabular-nums">
        {rows.map((day) => (
          <tr key={day.day}>
            <th scope="row" className="font-mono font-normal! text-foreground!">
              {formatDayKey(day.day)}
            </th>
            <td className="text-right">{formatNumber(day.visitors)}</td>
            <td className="text-right">{formatNumber(day.signedInVisitors)}</td>
            <td className="text-right">{formatNumber(day.views)}</td>
            <td className="text-right">{formatNumber(day.newUsers)}</td>
            {/* 单元格只写总对局数，悬停给出各游戏的分项，省掉三列占宽 */}
            <Hint
              label={GAMES.map((game) => `${GAME_LABELS[game]} ${day.games[game]}`).join(" · ")}
            >
              <td className="text-right">{formatNumber(sumGames(day.games))}</td>
            </Hint>
            <td className="text-right">{formatNumber(day.roundPlayers)}</td>
          </tr>
        ))}
      </tbody>
    </AdminTable>
  );
}

function PageViews({ data }: { data: AdminOverview }) {
  if (!data.pages.length)
    return <p className="text-sm text-muted-foreground">所选时段内没有浏览记录</p>;
  const max = Math.max(...data.pages.map((page) => page.views));
  return (
    <ol className="grid gap-2 text-sm">
      {data.pages.map((page) => (
        <li
          key={page.path}
          className="grid grid-cols-[minmax(0,10rem)_minmax(0,1fr)_auto] items-center gap-3"
        >
          <span className="truncate font-mono text-xs">{page.path}</span>
          <span className="h-2 rounded-full bg-muted" aria-hidden="true">
            <span
              className="block h-2 rounded-full bg-primary/60"
              style={{ width: `${Math.max(2, (page.views / max) * 100)}%` }}
            />
          </span>
          <span className="tabular-nums text-muted-foreground">{formatNumber(page.views)}</span>
        </li>
      ))}
    </ol>
  );
}

function SentryCard({
  data,
  loading,
  onReload,
}: {
  data: SentryOverview | null;
  loading: boolean;
  onReload: () => void;
}) {
  return (
    <section aria-labelledby="admin-sentry" className="rounded-md border bg-card p-4">
      <div className="mb-3 flex items-center justify-between gap-3">
        <h3 id="admin-sentry" className="font-semibold">
          错误与性能（近 24 小时）
        </h3>
        <Button type="button" variant="ghost" size="sm" loading={loading} onClick={onReload}>
          刷新
        </Button>
      </div>
      {!data ? (
        <p className="text-sm text-muted-foreground">
          {loading ? "正在查询 Sentry" : "Sentry 查询失败"}
        </p>
      ) : !data.configured ? (
        <p className="text-sm text-muted-foreground">
          服务端未配置 SENTRY_API_TOKEN，暂不展示错误与性能数据。
        </p>
      ) : (
        <div className="grid gap-4">
          <div className="flex flex-wrap gap-6 text-sm">
            <span>
              错误事件 <strong className="tabular-nums">{formatNumber(data.errors24h)}</strong>
            </span>
            <span>
              未解决问题{" "}
              <strong className="tabular-nums">{formatNumber(data.unresolvedIssues)}</strong>
            </span>
            {data.fetchedAt ? (
              <span className="text-muted-foreground">
                查询于 {formatShortDateTime(data.fetchedAt)}
              </span>
            ) : null}
          </div>
          {data.warnings.map((warning) => (
            <p key={warning} className="text-xs text-warning">
              {warning}
            </p>
          ))}
          {data.issues.length ? (
            <ul className="grid gap-2 text-sm">
              {data.issues.map((issue) => (
                <li key={issue.id} className="flex min-w-0 items-start gap-2">
                  <Badge
                    variant={
                      issue.level === "error" || issue.level === "fatal" ? "restricted" : "subtle"
                    }
                    size="xs"
                    className="mt-0.5 shrink-0"
                  >
                    {issue.level}
                  </Badge>
                  <span className="min-w-0 flex-1">
                    {issue.permalink ? (
                      <a
                        href={issue.permalink}
                        target="_blank"
                        rel="noreferrer"
                        className="group inline-flex max-w-full items-center gap-1 underline-offset-4 hover:underline"
                      >
                        <span className="truncate">{issue.title}</span>
                        <ExternalLink
                          className="h-3 w-3 shrink-0 opacity-40 transition group-hover:translate-x-0.5 group-hover:-translate-y-0.5 group-hover:opacity-100"
                          aria-hidden="true"
                        />
                      </a>
                    ) : (
                      <span className="block truncate">{issue.title}</span>
                    )}
                    <span className="block truncate text-xs text-muted-foreground">
                      {issue.shortId} · {issue.count} 次 · {issue.userCount} 人 · 最近{" "}
                      {formatShortDateTime(issue.lastSeen)}
                    </span>
                  </span>
                </li>
              ))}
            </ul>
          ) : (
            <p className="text-sm text-muted-foreground">没有未解决的问题</p>
          )}
          {data.transactions?.length ? (
            <AdminTable label="接口耗时" className="shadow-none">
              <thead>
                <tr>
                  <th scope="col">事务</th>
                  <th scope="col" className="text-right!">
                    次数
                  </th>
                  <th scope="col" className="text-right!">
                    p75
                  </th>
                  <th scope="col" className="text-right!">
                    p95
                  </th>
                </tr>
              </thead>
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
  const [, setParams] = useSearchParams();
  const overview = useAdminQuery(
    `overview:${days}`,
    () => api.admin.stats.overview({ days: Number(days) }),
    "概览加载失败"
  );
  const sentry = useAdminQuery("sentry", () => api.admin.stats.sentry(), "Sentry 查询失败");
  // 只取条数：limit 1 就够，队列分页留在反作弊标签里做。
  const openReview = useAdminQuery(
    "open-review-count",
    () => api.admin.antiCheat.list({ status: "open", limit: 1 }),
    "待复核条数加载失败"
  );
  const data = overview.data;
  return (
    <div className="grid gap-6">
      <div>
        <AdminToolbar
          title="站点概览"
          onReload={overview.reload}
          loading={overview.loading && Boolean(data)}
        >
          <SegmentedControl
            aria-label="统计天数"
            size="sm"
            value={days}
            onValueChange={setDays}
            options={DAY_OPTIONS}
          />
        </AdminToolbar>
        <QueryState
          loading={overview.loading}
          error={overview.error}
          empty={false}
          hasData={Boolean(data)}
          onRetry={overview.reload}
          emptyText=""
        />
        {data ? <OverviewStats data={data} /> : null}
        {/* 待复核条数只在概览露个脸：处置动作全部留在反作弊标签，两个入口改同一条会互相盖掉。
            计数为 0 也照样显示，读作「这条链路在跑」，而不是「没接上」。 */}
        {openReview.data ? (
          <div className="mt-3 flex flex-wrap items-center justify-between gap-3 rounded-md border bg-card px-4 py-3">
            <div className="flex flex-wrap items-baseline gap-2 text-sm">
              <span className="text-muted-foreground">反作弊待复核</span>
              <strong className="text-2xl font-semibold tabular-nums">
                {formatNumber(openReview.data.total)}
              </strong>
              <span className="text-xs text-muted-foreground">条 · 候选不是结论</span>
            </div>
            <Button
              type="button"
              size="sm"
              variant="outline"
              // 跨标签跳转保留历史：看完概览还能退回，与页内切标签的 replace 不同。
              onClick={() => setParams({ tab: "anticheat" })}
            >
              去复核
            </Button>
          </div>
        ) : null}
      </div>
      {data ? (
        <section aria-labelledby="admin-daily" className="grid gap-3">
          <h3 id="admin-daily" className="font-semibold">
            每日数据
          </h3>
          <DailyTable data={data} />
          <p className="text-xs text-muted-foreground">
            按北京时间自然日统计；一局 = 一个房间从创建到销毁，对局记录永久保留。
          </p>
        </section>
      ) : null}
      {data ? (
        <section aria-labelledby="admin-pages" className="grid gap-3">
          <h3 id="admin-pages" className="font-semibold">
            板块浏览
          </h3>
          <PageViews data={data} />
        </section>
      ) : null}
      <SentryCard data={sentry.data} loading={sentry.loading} onReload={sentry.reload} />
    </div>
  );
}
