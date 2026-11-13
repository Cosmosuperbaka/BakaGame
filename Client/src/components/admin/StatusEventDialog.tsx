import { useState } from "react";
import { PUBLIC_STATUS_COMPONENT_IDS } from "@bakagame/shared/values";
import type {
  PublicStatusComponentId,
  PublicStatusEvent,
  PublicStatusIncidentKind,
} from "@bakagame/shared";
import { Input } from "@/components/ui/Input";
import { Textarea } from "@/components/ui/Textarea";
import { ToggleChip } from "@/components/ui/ToggleChip";
import { SettingsReadOnly } from "@/components/common/room/settings/Layout";
import { SettingSelect, SettingSegmented } from "@/components/common/room/settings/ChoiceFields";
import { SettingTextField } from "@/components/common/room/settings/TextFields";
import { AdminFormDialog } from "@/components/admin/AdminParts";
import { useAdminAction } from "@/hooks/UseAdminQuery";
import { api } from "@/lib/Api";
import { STATUS_COMPONENT_LABELS, STATUS_EVENT_STATUS_LABELS } from "@/lib/SystemStatus";

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
  /** 进度档位；只有编辑时可改，新建由服务端按类型定初始档。 */
  status: string;
  title: string;
  body: string;
  components: PublicStatusComponentId[];
  startedAt: string;
  plannedEndAt: string;
}

const draftOf = (event?: PublicStatusEvent): EventDraft => ({
  kind: event?.kind ?? "incident",
  status: event?.status ?? "investigating",
  title: event?.title ?? "",
  body: event?.body ?? "",
  components: event?.components ?? [],
  startedAt: toInputValue(event?.startedAt ?? Date.now()),
  plannedEndAt:
    event?.plannedEndAt !== undefined && event.plannedEndAt !== null
      ? toInputValue(event.plannedEndAt)
      : "",
});

/**
 * 影响组件的多选：留空表示全站；chips 自带按压反馈，与设置页同一手感。
 * 未选态的虚线取弱前景色而不是 --border：后者在暗色弹窗底上几乎看不见，胶囊只剩一行字。
 */
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
            <ToggleChip
              key={option.value}
              pressed={pressed}
              idleClassName="border-muted-foreground/40"
              onPressedChange={() =>
                onChange(
                  pressed
                    ? selected.filter((item) => item !== option.value)
                    : [...selected, option.value]
                )
              }
            >
              {option.label}
            </ToggleChip>
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
export function EventDialog({
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
  // 内容框只在动过之后才标红：新建表单一打开就是一圈红框，读作「已经填错了」。
  const [bodyTouched, setBodyTouched] = useState(false);
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
            status: draft.status as PublicStatusEvent["status"],
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
    <AdminFormDialog
      title={editing ? "修改状态事件" : "发布状态事件"}
      description={
        <>
          {draft.kind === "incident"
            ? "事件面向玩家说明正在发生的故障，恢复时把进度改为「已恢复」。"
            : "维护窗口说明计划中的停机或升级，到点后改为「进行中」，完成后改为「已完成」。"}
          发布与修改都会记进审计。
        </>
      }
      busy={Boolean(action.busy)}
      error={action.error}
      submitLabel={editing ? "保存修改" : "发布"}
      submitDisabled={invalid}
      onClose={() => onOpenChange(false)}
      onSubmit={() => void save()}
    >
      {/* 服务端更新沿用既有类型：编辑时类型只读，只在新建时给切换。 */}
      <SettingsReadOnly readOnly={editing}>
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
      </SettingsReadOnly>
      {editing ? (
        <SettingSelect
          label="进度"
          value={draft.status}
          options={STATUS_OPTIONS[draft.kind]}
          onChange={(status) => setDraft((current) => ({ ...current, status }))}
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
          aria-invalid={(bodyTouched && draft.body.trim().length === 0) || undefined}
          onChange={(event) => {
            setBodyTouched(true);
            setDraft((current) => ({ ...current, body: event.target.value }));
          }}
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
    </AdminFormDialog>
  );
}
