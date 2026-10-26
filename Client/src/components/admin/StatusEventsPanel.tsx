import { useState } from "react";
import { motion } from "framer-motion";
import {
  PUBLIC_STATUS_COMPONENT_IDS,
  type PublicStatusComponentId,
  type PublicStatusEvent,
  type PublicStatusIncidentKind,
} from "@bakagame/shared";
import { Badge } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/Dialog";
import { Input } from "@/components/ui/Input";
import { Textarea } from "@/components/ui/Textarea";
import {
  SettingSelect,
  SettingSegmented,
  SettingTextField,
  SettingsFields,
} from "@/components/common/room/SettingFields";
import { tappable } from "@/lib/Motion";
import {
  AdminTable,
  AdminToolbar,
  ConfirmDialog,
  Pager,
  QueryState,
} from "@/components/admin/AdminParts";
import { useAdminAction, useAdminQuery } from "@/hooks/UseAdminQuery";
import { api, apiErrorMessage } from "@/lib/Api";
import { formatDateTime } from "@/lib/AdminFormat";
import { STATUS_COMPONENT_LABELS, STATUS_EVENT_STATUS_LABELS } from "@/lib/SystemStatus";
import { cn } from "@/lib/Utils";

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

/** 各类型的合法进度档：与服务端 `statusOfKind` 同一张表。 */
const STATUS_OPTIONS: Record<PublicStatusIncidentKind, Array<{ value: string; label: string }>> = {
  incident: ["investigating", "identified", "monitoring", "resolved"].map((value) => ({
    value,
    label: STATUS_EVENT_STATUS_LABELS[value as keyof typeof STATUS_EVENT_STATUS_LABELS],
  })),
  maintenance: ["scheduled", "in_progress", "done"].map((value) => ({
    value,
    label: STATUS_EVENT_STATUS_LABELS[value as keyof typeof STATUS_EVENT_STATUS_LABELS],
  })),
};

const COMPONENT_OPTIONS = PUBLIC_STATUS_COMPONENT_IDS.map((id) => ({
  value: id,
  label: STATUS_COMPONENT_LABELS[id],
}));

/** `datetime-local` 的值（浏览器本地时间）↔ epoch 毫秒。 */
const toInputValue = (ms: number): string => {
  const date = new Date(ms);
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
};
const fromInputValue = (value: string): number | null => {
  const ms = new Date(value).getTime();
  return Number.isFinite(ms) ? ms : null;
};

interface EventDraft {
  kind: PublicStatusIncidentKind;
  title: string;
  body: string;
  components: PublicStatusComponentId[];
  startedAt: string;
  plannedEndAt: string;
}

const draftOf = (event?: PublicStatusEvent): EventDraft => ({
  kind: event?.kind ?? "incident",
  title: event?.title ?? "",
  body: event?.body ?? "",
  components: event?.components ?? [],
  startedAt: toInputValue(event?.startedAt ?? Date.now()),
  plannedEndAt:
    event?.plannedEndAt !== undefined && event.plannedEndAt !== null
      ? toInputValue(event.plannedEndAt)
      : "",
});

/** 影响组件的多选：留空表示全站；chips 自带按压反馈，与设置页同一手感。 */
function ComponentChips({
  selected,
  onChange,
}: {
  selected: PublicStatusComponentId[];
  onChange: (next: PublicStatusComponentId[]) => void;
}) {
  const chosen = new Set(selected);
  return (
    <div className="grid gap-2">
      <span className="font-serif text-sm leading-snug">影响组件</span>
      <div className="flex flex-wrap gap-1.5">
        {COMPONENT_OPTIONS.map((option) => {
          const pressed = chosen.has(option.value);
          return (
            <motion.button
              key={option.value}
              type="button"
              {...tappable}
              aria-pressed={pressed}
              onClick={() =>
                onChange(
                  pressed
                    ? selected.filter((item) => item !== option.value)
                    : [...selected, option.value]
                )
              }
              className={cn(
                "rounded-full border px-3 py-1 text-xs transition-colors",
                pressed
                  ? "border-primary/40 bg-primary/10 font-medium text-primary"
                  : "border-dashed border-border bg-transparent text-muted-foreground hover:border-solid hover:text-foreground"
              )}
            >
              {option.label}
            </motion.button>
          );
        })}
      </div>
      <p className="text-xs leading-relaxed text-muted-foreground">
        不选任何组件表示全站受影响；状态页的条格悬停与事件卡都按这里关联。
      </p>
    </div>
  );
}

/** 新建与编辑共用一个表单：编辑多一个进度档位；维护窗口要求计划结束晚于开始。 */
function EventDialog({
  event,
  onOpenChange,
  onSaved,
}: {
  event: PublicStatusEvent | null;
  onOpenChange: (open: boolean) => void;
  onSaved: () => void;
}) {
  const editing = event !== null;
  const [draft, setDraft] = useState<EventDraft>(() => draftOf(event ?? undefined));
  const [status, setStatus] = useState<string>(event?.status ?? "investigating");
  const action = useAdminAction();

  const startedMs = fromInputValue(draft.startedAt);
  const endedMs = fromInputValue(draft.plannedEndAt);
  const invalid =
    draft.title.trim().length === 0 ||
    draft.body.trim().length === 0 ||
    startedMs === null ||
    (draft.kind === "maintenance" && (endedMs === null || endedMs <= startedMs));

  const save = async () => {
    const ok = await action.run(
      "save",
      async () => {
        if (editing) {
          await api.admin.statusEvents.update({
            id: event.id,
            title: draft.title.trim(),
            body: draft.body.trim(),
            status: status as PublicStatusEvent["status"],
            components: draft.components,
            startedAt: startedMs!,
            plannedEndAt: draft.kind === "maintenance" ? endedMs : null,
          });
        } else {
          await api.admin.statusEvents.create({
            kind: draft.kind,
            title: draft.title.trim(),
            body: draft.body.trim(),
            components: draft.components,
            startedAt: startedMs!,
            plannedEndAt: draft.kind === "maintenance" ? endedMs : null,
          });
        }
        onSaved();
      },
      "保存失败，请稍后重试"
    );
    if (ok) onOpenChange(false);
  };

  return (
    <Dialog open onOpenChange={(next) => !action.busy && onOpenChange(next)}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{editing ? "修改状态事件" : "发布状态事件"}</DialogTitle>
          <DialogDescription>
            {draft.kind === "incident"
              ? "事件面向玩家说明正在发生的故障，恢复时把进度改为「已恢复」。"
              : "维护窗口说明计划中的停机或升级，到点后改为「进行中」，完成后改为「已完成」。"}
            发布与修改都会记进审计。
          </DialogDescription>
        </DialogHeader>
        <SettingsFields>
          <SettingSegmented
            label="类型"
            value={draft.kind}
            onValueChange={(kind) =>
              setDraft((current) => ({
                ...current,
                kind,
                status: kind === "incident" ? "investigating" : "scheduled",
              }))
            }
            options={[
              { value: "incident", label: "故障事件" },
              { value: "maintenance", label: "维护窗口" },
            ]}
          />
          {editing ? (
            <SettingSelect
              label="进度"
              value={status}
              options={STATUS_OPTIONS[draft.kind]}
              onChange={setStatus}
            />
          ) : null}
          <SettingTextField
            label="标题"
            value={draft.title}
            onChange={(title) => setDraft((current) => ({ ...current, title }))}
            placeholder="一句话说清影响"
            maxLength={120}
          />
          <div className="grid gap-2">
            <label htmlFor="status-event-body" className="font-serif text-sm leading-snug">
              内容
            </label>
            <Textarea
              id="status-event-body"
              value={draft.body}
              maxLength={4000}
              placeholder="影响范围、原因与预计恢复时间"
              aria-invalid={draft.body.trim().length === 0 || undefined}
              onChange={(event) =>
                setDraft((current) => ({ ...current, body: event.target.value }))
              }
            />
          </div>
          <ComponentChips
            selected={draft.components}
            onChange={(components) => setDraft((current) => ({ ...current, components }))}
          />
          <div className="grid gap-2">
            <label htmlFor="status-event-start" className="font-serif text-sm leading-snug">
              {draft.kind === "maintenance" ? "窗口开始" : "开始时间"}
            </label>
            <Input
              id="status-event-start"
              type="datetime-local"
              value={draft.startedAt}
              onChange={(event) =>
                setDraft((current) => ({ ...current, startedAt: event.target.value }))
              }
            />
          </div>
          {draft.kind === "maintenance" ? (
            <div className="grid gap-2">
              <label htmlFor="status-event-end" className="font-serif text-sm leading-snug">
                窗口结束
              </label>
              <Input
                id="status-event-end"
                type="datetime-local"
                value={draft.plannedEndAt}
                aria-invalid={
                  endedMs === null || (startedMs !== null && endedMs <= startedMs) || undefined
                }
                onChange={(event) =>
                  setDraft((current) => ({ ...current, plannedEndAt: event.target.value }))
                }
              />
              <p className="text-xs leading-relaxed text-muted-foreground">
                维护窗口必须给出晚于开始时刻的结束时间。
              </p>
            </div>
          ) : null}
        </SettingsFields>
        {action.error ? (
          <p role="alert" className="text-sm text-destructive">
            {action.error}
          </p>
        ) : null}
        <DialogFooter>
          <Button
            type="button"
            variant="outline"
            disabled={Boolean(action.busy)}
            onClick={() => onOpenChange(false)}
          >
            取消
          </Button>
          <Button
            type="button"
            loading={Boolean(action.busy)}
            disabled={invalid}
            onClick={() => void save()}
          >
            {editing ? "保存修改" : "发布"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/**
 * 状态页的事件与维护管理：发布、推进进度、删除，全部经 oRPC `admin.statusEvents.*`，
 * 写操作在服务端先审计再执行；数据按部署环境隔离，这里只看到本环境的事件。
 */
export function StatusEventsPanel() {
  const [filter, setFilter] = useState<StatusEventFilter>("all");
  const [offset, setOffset] = useState(0);
  const [editing, setEditing] = useState<PublicStatusEvent | null>(null);
  const [creating, setCreating] = useState(false);
  const [removing, setRemoving] = useState<PublicStatusEvent | null>(null);

  const query = useAdminQuery(
    `statusEvents:${filter}:${offset}`,
    async () =>
      api.admin.statusEvents.list({
        ...(filter === "active" ? { active: true } : {}),
        ...(filter === "incident" || filter === "maintenance" ? { kind: filter } : {}),
        limit: PAGE_LIMIT,
        offset,
      }),
    "状态事件加载失败"
  );
  const items = query.data?.items ?? [];
  const total = query.data?.total ?? 0;
  const reload = query.reload;

  return (
    <div>
      <AdminToolbar
        title="状态事件"
        count={total}
        onReload={reload}
        loading={query.loading && Boolean(query.data)}
      >
        <Button type="button" size="sm" onClick={() => setCreating(true)}>
          发布事件
        </Button>
      </AdminToolbar>
      <p className="mb-4 text-sm text-muted-foreground">
        面向状态页的故障通告与维护窗口：进行中的一律展示，已结束的回看一个月。
        事件与维护只出现在本部署环境的状态页上。
      </p>
      <div className="mb-4">
        <SettingSegmented
          label="筛选"
          value={filter}
          onValueChange={(next) => {
            setFilter(next);
            setOffset(0);
          }}
          options={FILTER_OPTIONS}
        />
      </div>
      <QueryState
        loading={query.loading}
        error={query.error}
        empty={Boolean(query.data) && items.length === 0}
        hasData={Boolean(query.data)}
        onRetry={reload}
        emptyText="没有匹配的状态事件"
      />
      {items.length ? (
        <AdminTable label="状态事件">
          <thead>
            <tr>
              <th scope="col">类型</th>
              <th scope="col">标题</th>
              <th scope="col">进度</th>
              <th scope="col">影响组件</th>
              <th scope="col">时间</th>
              <th scope="col"> </th>
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
                      className="text-destructive hover:bg-destructive/10"
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
      <Pager offset={offset} limit={PAGE_LIMIT} total={total} onChange={setOffset} />

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
