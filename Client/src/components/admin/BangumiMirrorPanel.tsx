import type { ReactNode } from "react";
import { CircleAlert, CircleCheck, TriangleAlert } from "lucide-react";
import type { AdminBangumiMirrorStatus } from "@bakagame/shared";
import { Badge } from "@/components/ui/Badge";
import { AdminTable, AdminToolbar, QueryState, Stat } from "@/components/admin/AdminParts";
import { useAdminQuery } from "@/hooks/UseAdminQuery";
import { api } from "@/lib/Api";
import { formatDateTime, formatNumber } from "@/lib/AdminFormat";
import { cn } from "@/lib/Utils";

type Alert = AdminBangumiMirrorStatus["alerts"][number];
type Dataset = NonNullable<AdminBangumiMirrorStatus["dataset"]>;
type Run = Dataset["maintenance"][number];

const TASKS = [
  { task: "discovery", label: "新条目发现" },
  { task: "backup", label: "数据集备份" },
  { task: "tagDiff", label: "角色标签增量" },
] as const;

const ALERT_STYLES = {
  error: {
    icon: CircleAlert,
    label: "故障",
    box: "border-destructive/40 bg-destructive/10",
    tone: "text-destructive",
  },
  warning: {
    icon: TriangleAlert,
    label: "注意",
    box: "border-warning/40 bg-warning/10",
    tone: "text-warning",
  },
} as const;

function Moment({ value }: { value: number | null }) {
  if (value === null) return <>—</>;
  return <span className="font-mono">{formatDateTime(value)}</span>;
}

/** 面板最上方：有问题就列问题，判定来自服务端，这里只负责展示。 */
function MirrorAlerts({ alerts }: { alerts: Alert[] }) {
  if (!alerts.length) {
    return (
      <p className="flex items-center gap-2 rounded-md border bg-card px-4 py-3 text-sm">
        <CircleCheck className="size-4 shrink-0 text-success" aria-hidden="true" />
        更新正常，没有超期或失败的任务
      </p>
    );
  }
  return (
    <ul aria-label="需要处理的问题" className="grid gap-2">
      {alerts.map((alert) => {
        const style = ALERT_STYLES[alert.level];
        const Icon = style.icon;
        return (
          <li
            key={alert.code}
            className={cn("flex items-start gap-2 rounded-md border px-4 py-3 text-sm", style.box)}
          >
            <Icon className={cn("mt-0.5 size-4 shrink-0", style.tone)} aria-hidden="true" />
            <span className="min-w-0 break-words">
              <strong className={cn("mr-2 font-semibold", style.tone)}>{style.label}</strong>
              {alert.message}
            </span>
          </li>
        );
      })}
    </ul>
  );
}

function Fields({ id, title, children }: { id: string; title: string; children: ReactNode }) {
  return (
    <section aria-labelledby={id} className="rounded-md border bg-card p-4">
      <h3 id={id} className="font-semibold">
        {title}
      </h3>
      <dl className="mt-2 grid gap-1 text-sm">{children}</dl>
    </section>
  );
}

function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex items-baseline justify-between gap-3">
      <dt className="shrink-0 text-muted-foreground">{label}</dt>
      <dd className="min-w-0 break-words text-right tabular-nums">{children}</dd>
    </div>
  );
}

function FreshnessFields({ dataset }: { dataset: Dataset }) {
  return (
    <Fields id="bangumi-freshness" title="数据新鲜度">
      <Field label="最近回源刷新">
        {dataset.latestRefreshAt === null ? "尚无" : <Moment value={dataset.latestRefreshAt} />}
      </Field>
      <Field label="基线登记">
        <Moment value={dataset.baselineAt} />
      </Field>
      <Field label="数据文件写入">
        <Moment value={dataset.fileUpdatedAt} />
      </Field>
      <Field label="最新作品日期">
        <span className="font-mono">{dataset.latestSubjectDate ?? "—"}</span>
      </Field>
      <Field label="已跟踪作品">{formatNumber(dataset.refreshed)}</Field>
    </Fields>
  );
}

function UpdaterState({ status }: { status: AdminBangumiMirrorStatus }) {
  const { role, updater } = status;
  if (!updater) {
    return role === "reader" ? (
      <Badge variant="subtle">由主分片负责</Badge>
    ) : (
      <Badge variant="restricted">未启用</Badge>
    );
  }
  if (!updater.running) return <Badge variant="destructive">已停止</Badge>;
  return updater.paused ? (
    <Badge variant="upcoming">备份中暂停</Badge>
  ) : (
    <Badge variant="matched">运行中</Badge>
  );
}

function UpdaterFields({ status }: { status: AdminBangumiMirrorStatus }) {
  const { updater } = status;
  return (
    <Fields id="bangumi-updater" title="更新器">
      <Field label="状态">
        <UpdaterState status={status} />
      </Field>
      <Field label="当前速率">{updater ? `${updater.rate.toFixed(1)} 次/秒` : "—"}</Field>
      <Field label="在线玩家">{formatNumber(updater?.players)}</Field>
      <Field label="本次启动">
        <Moment value={updater?.startedAt ?? null} />
      </Field>
      <Field label="上轮完成">
        <Moment value={updater?.lastRound?.at ?? null} />
      </Field>
      <Field label="上轮刷新">
        {updater?.lastRound ? `${formatNumber(updater.lastRound.refreshed)} 条` : "—"}
      </Field>
    </Fields>
  );
}

function ProviderFields({ provider }: { provider: AdminBangumiMirrorStatus["provider"] }) {
  return (
    <Fields id="bangumi-provider" title="查询链路">
      <Field label="当前查询">
        {provider.mode === "local" ? (
          <Badge variant="matched">本地数据</Badge>
        ) : (
          <Badge variant="destructive">网络回源</Badge>
        )}
      </Field>
      <Field label="启动以来降级">{`${formatNumber(provider.degradedCount)} 次`}</Field>
      <Field label="最近降级">
        <Moment value={provider.lastDegradedAt} />
      </Field>
      <Field label="最近错误码">
        <span className="font-mono text-xs">{provider.lastErrorCode ?? "—"}</span>
      </Field>
      <Field label="下次探测本地">
        <Moment value={provider.retryAt} />
      </Field>
    </Fields>
  );
}

function SearchState({ search }: { search: AdminBangumiMirrorStatus["search"] }) {
  if (!search.configured) return <Badge variant="unavailable">未配置</Badge>;
  return search.healthy ? (
    <Badge variant="matched">可用</Badge>
  ) : (
    <Badge variant="destructive">不可用</Badge>
  );
}

function SearchFields({ search }: { search: AdminBangumiMirrorStatus["search"] }) {
  return (
    <Fields id="bangumi-search" title="搜索索引">
      <Field label="状态">
        <SearchState search={search} />
      </Field>
      <Field label="作品文档">{formatNumber(search.subjects)}</Field>
      <Field label="角色文档">{formatNumber(search.characters)}</Field>
      <Field label="索引任务">{search.isIndexing ? "进行中" : "空闲"}</Field>
    </Fields>
  );
}

function RunResult({ run, configured }: { run?: Run; configured: boolean }) {
  if (!configured) return <Badge variant="unavailable">未配置</Badge>;
  if (!run) return <Badge variant="upcoming">暂无记录</Badge>;
  return run.ok ? (
    <Badge variant="matched">成功</Badge>
  ) : (
    <Badge variant="destructive">失败</Badge>
  );
}

const runSummary = (run: Run | undefined, configured: boolean): string => {
  if (!configured) return "未配置增量来源，角色标签不会自动更新";
  if (!run) return "—";
  return run.error ? `${run.summary}：${run.error}` : run.summary;
};

function MaintenanceTable({ status }: { status: AdminBangumiMirrorStatus }) {
  const runs = status.dataset?.maintenance ?? [];
  return (
    <AdminTable label="维护任务">
      <thead>
        <tr>
          <th scope="col">任务</th>
          <th scope="col">结果</th>
          <th scope="col">最近完成</th>
          <th scope="col">摘要</th>
          <th scope="col">下次计划</th>
        </tr>
      </thead>
      <tbody>
        {TASKS.map(({ task, label }) => {
          const run = runs.find((item) => item.task === task);
          const configured = task !== "tagDiff" || status.schedule.tagDiffConfigured;
          return (
            <tr key={task}>
              <td className="whitespace-nowrap">{label}</td>
              <td className="whitespace-nowrap">
                <RunResult run={run} configured={configured} />
              </td>
              <td className="whitespace-nowrap">
                <Moment value={run?.finishedAt ?? null} />
              </td>
              <td className="break-words">{runSummary(run, configured)}</td>
              <td className="whitespace-nowrap">
                <Moment value={task === "tagDiff" ? null : status.schedule.nextDailyAt} />
              </td>
            </tr>
          );
        })}
      </tbody>
    </AdminTable>
  );
}

export function BangumiMirrorView({ status }: { status: AdminBangumiMirrorStatus }) {
  const { dataset } = status;
  return (
    <div className="grid gap-6">
      <MirrorAlerts alerts={status.alerts} />
      {dataset ? (
        <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
          <Stat label="作品" value={dataset.subjects} />
          <Stat label="角色" value={dataset.characters} />
          <Stat label="刷新退避中" value={dataset.failingSubjects} detail="连续失败，等待重试" />
          <Stat label="待同步索引" value={dataset.pendingIndex} />
        </div>
      ) : null}
      <div className="grid gap-3 md:grid-cols-2">
        {dataset ? <FreshnessFields dataset={dataset} /> : null}
        <UpdaterFields status={status} />
        <ProviderFields provider={status.provider} />
        <SearchFields search={status.search} />
      </div>
      <section aria-labelledby="bangumi-tasks" className="grid gap-3">
        <h3 id="bangumi-tasks" className="font-semibold">
          维护任务
        </h3>
        <MaintenanceTable status={status} />
        <p className="text-xs text-muted-foreground">
          状态生成于 <Moment value={status.generatedAt} />
        </p>
      </section>
    </div>
  );
}

export function BangumiMirrorPanel() {
  const query = useAdminQuery(
    "bangumiMirror",
    () => api.admin.bangumiMirror.status(),
    "镜像状态加载失败"
  );
  return (
    <div>
      <AdminToolbar
        title="Bangumi 镜像"
        onReload={query.reload}
        loading={query.loading && Boolean(query.data)}
      />
      <QueryState
        loading={query.loading}
        error={query.error}
        empty={false}
        hasData={Boolean(query.data)}
        onRetry={query.reload}
        emptyText="暂无镜像状态"
      />
      {query.data ? <BangumiMirrorView status={query.data} /> : null}
    </div>
  );
}
