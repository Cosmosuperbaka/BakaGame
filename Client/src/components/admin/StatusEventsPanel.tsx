import { useState } from "react";
import type { PublicStatusEvent, PublicStatusIncidentKind } from "@bakagame/shared";
import { Badge } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import { SegmentedControl } from "@/components/ui/SegmentedControl";
import { ConfirmDialog } from "@/components/common/ConfirmDialog";
import { AdminTable, AdminToolbar, ListState, Pager } from "@/components/admin/AdminParts";
import { EventDialog } from "@/components/admin/StatusEventDialog";
import { useAdminList } from "@/hooks/UseAdminList";
import { api, apiErrorMessage } from "@/lib/Api";
import { formatDateTime } from "@/lib/AdminFormat";
import { STATUS_COMPONENT_LABELS, STATUS_EVENT_STATUS_LABELS } from "@/lib/SystemStatus";

const PAGE_LIMIT = 20;

type StatusEventFilter = "all" | "active" | "incident" | "maintenance";

const FILTER_OPTIONS: Array<{ value: StatusEventFilter; label: string }> = [
  { value: "all", label: "全部" },
  { value: "active", label: "进行中" },
  { value: "incident", label: "事件" },
  { value: "maintenance", label: "维护" },
];

const KIND_LABELS: Record<PublicStatusIncidentKind, string> = {
  incident: "事件",
  maintenance: "维护",
};

/**
 * 状态页的事件与维护管理：发布、推进进度、删除，全部经 oRPC `admin.statusEvents.*`，
 * 写操作在服务端先审计再执行；数据按部署环境隔离，这里只看到本环境的事件。
 */
export function StatusEventsPanel() {
  const [filter, setFilter] = useState<StatusEventFilter>("all");
  const [editing, setEditing] = useState<PublicStatusEvent | null>(null);
  const [creating, setCreating] = useState(false);
  const [removing, setRemoving] = useState<PublicStatusEvent | null>(null);

  const list = useAdminList({
    name: "statusEvents",
    filters: {
      ...(filter === "active" ? { active: true } : {}),
      ...(filter === "incident" || filter === "maintenance" ? { kind: filter } : {}),
    },
    limit: PAGE_LIMIT,
    fallback: "状态事件加载失败",
    fetch: (input) => api.admin.statusEvents.list(input),
  });
  const { items, query } = list;
  const reload = query.reload;

  return (
    <div>
      <AdminToolbar title="状态事件" compact {...list.toolbar}>
        {/* 筛选与其它面板一样放进标题行；原先独占一行的设置行写法在手机上放不下四个选项，把页面撑出右缘。 */}
        <SegmentedControl
          aria-label="筛选"
          size="sm"
          value={filter}
          onValueChange={setFilter}
          options={FILTER_OPTIONS}
        />
        <Button type="button" size="sm" onClick={() => setCreating(true)}>
          发布事件
        </Button>
      </AdminToolbar>
      <p className="mb-4 text-sm text-muted-foreground">
        面向状态页的故障通告与维护窗口：进行中的一律展示，已结束的回看一个月。
        事件与维护只出现在本部署环境的状态页上。
      </p>
      <ListState list={list} emptyText="没有匹配的状态事件" />
      {items.length ? (
        <AdminTable label="状态事件">
          <thead>
            <tr>
              <th scope="col">类型</th>
              <th scope="col">标题</th>
              <th scope="col">进度</th>
              <th scope="col">影响组件</th>
              <th scope="col">时间</th>
              <th scope="col">
                <span className="sr-only">操作</span>
              </th>
            </tr>
          </thead>
          <tbody>
            {items.map((event) => (
              <tr key={event.id}>
                <td className="whitespace-nowrap">{KIND_LABELS[event.kind]}</td>
                <td className="max-w-72">
                  <span className="block truncate font-medium">{event.title}</span>
                  <span className="block truncate text-xs text-muted-foreground">{event.body}</span>
                </td>
                <td className="whitespace-nowrap">
                  <Badge
                    variant={
                      event.kind === "incident"
                        ? event.resolvedAt === null
                          ? "restricted"
                          : "subtle"
                        : event.status === "done"
                          ? "subtle"
                          : "active"
                    }
                    size="xs"
                  >
                    {STATUS_EVENT_STATUS_LABELS[event.status]}
                  </Badge>
                </td>
                <td className="max-w-48 truncate text-xs text-muted-foreground">
                  {event.components
                    .map((component) => STATUS_COMPONENT_LABELS[component])
                    .join("、") || "全站"}
                </td>
                <td className="whitespace-nowrap text-xs text-muted-foreground">
                  <span className="block font-mono tabular-nums">
                    {formatDateTime(event.startedAt)}
                  </span>
                  <span className="block font-mono tabular-nums">
                    {event.plannedEndAt !== null
                      ? `计划至 ${formatDateTime(event.plannedEndAt)}`
                      : event.resolvedAt !== null
                        ? `结束于 ${formatDateTime(event.resolvedAt)}`
                        : "进行中"}
                  </span>
                </td>
                <td>
                  <div className="flex gap-2">
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      disabled={query.loading}
                      onClick={() => setEditing(event)}
                    >
                      修改
                    </Button>
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      className="text-destructive hover:bg-destructive/10 hover:text-destructive"
                      disabled={query.loading}
                      onClick={() => setRemoving(event)}
                    >
                      删除
                    </Button>
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </AdminTable>
      ) : null}
      <Pager {...list.pager} />

      {creating ? (
        <EventDialog
          key="create"
          event={null}
          onOpenChange={(open) => {
            if (!open) setCreating(false);
          }}
          onSaved={reload}
        />
      ) : null}
      {editing ? (
        <EventDialog
          key={editing.id}
          event={editing}
          onOpenChange={(open) => {
            if (!open) setEditing(null);
          }}
          onSaved={reload}
        />
      ) : null}
      {removing ? (
        <ConfirmDialog
          open
          onOpenChange={(open) => {
            if (!open) setRemoving(null);
          }}
          title="删除状态事件"
          description={`确定删除「${removing.title}」？状态页将立即不再展示它，删除会留审计。`}
          confirmLabel="删除"
          onConfirm={async () => {
            try {
              await api.admin.statusEvents.remove({ id: removing.id });
              reload();
              return null;
            } catch (cause) {
              return apiErrorMessage(cause, "删除失败，请稍后重试");
            }
          }}
        />
      ) : null}
    </div>
  );
}
