import { useId, useState, type FormEvent } from "react";
import { FEEDBACK_REPLY_MAX_LENGTH } from "@bakagame/shared";
import type { AdminFeedbackDetail, FeedbackKind, FeedbackStatus } from "@/types";
import { Badge } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/Dialog";
import { Label } from "@/components/ui/Label";
import { Textarea } from "@/components/ui/Textarea";
import { SettingSelect } from "@/components/common/room/SettingFields";
import {
  AdminTable,
  AdminToolbar,
  Pager,
  QueryState,
  RowButton,
  UserCell,
} from "@/components/admin/AdminParts";
import { useAdminAction, useAdminQuery } from "@/hooks/UseAdminQuery";
import { api } from "@/lib/Api";
import { formatDateTime, formatShortDateTime } from "@/lib/AdminFormat";
import {
  FEEDBACK_KIND_LABELS,
  FEEDBACK_STATUS_BADGE,
  FEEDBACK_STATUS_LABELS,
} from "@/lib/FeedbackLabels";

const LIMIT = 20;
const STATUSES = Object.keys(FEEDBACK_STATUS_LABELS) as FeedbackStatus[];
const STATUS_OPTIONS = STATUSES.map((status) => ({
  value: status,
  label: FEEDBACK_STATUS_LABELS[status],
}));
const STATUS_FILTER = [{ value: "", label: "全部状态" }, ...STATUS_OPTIONS];
const KIND_FILTER = [
  { value: "", label: "全部类型" },
  ...(Object.keys(FEEDBACK_KIND_LABELS) as FeedbackKind[]).map((kind) => ({
    value: kind,
    label: FEEDBACK_KIND_LABELS[kind],
  })),
];

function FeedbackThread({
  detail,
  onChanged,
}: {
  detail: AdminFeedbackDetail;
  onChanged: (detail: AdminFeedbackDetail) => void;
}) {
  const [reply, setReply] = useState("");
  const replyId = useId();
  const action = useAdminAction();

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    const content = reply.trim();
    if (!content) return;
    const ok = await action.run(
      "reply",
      async () => onChanged(await api.admin.feedback.reply({ id: detail.id, content })),
      "回复失败，请稍后重试"
    );
    if (ok) setReply("");
  };
  const changeStatus = (status: string) => {
    void action.run("status", async () => {
      const summary = await api.admin.feedback.setStatus({
        id: detail.id,
        status: status as FeedbackStatus,
      });
      onChanged({ ...detail, ...summary });
    });
  };

  return (
    <div className="grid gap-4">
      <div className="flex flex-wrap items-center gap-2 text-sm">
        <Badge variant="outline" size="xs">
          {FEEDBACK_KIND_LABELS[detail.kind]}
        </Badge>
        <UserCell user={detail.user} />
        <span className="text-muted-foreground">提交于 {formatDateTime(detail.createdAt)}</span>
      </div>
      <p className="max-h-60 overflow-y-auto whitespace-pre-wrap break-words rounded-md border bg-card p-3 text-sm">
        {detail.content}
      </p>
      <dl className="grid gap-1 text-xs text-muted-foreground">
        {detail.page ? (
          <div>
            <dt className="inline">页面：</dt>
            <dd className="inline font-mono">{detail.page}</dd>
          </div>
        ) : null}
        {detail.userAgent ? (
          <div>
            <dt className="inline">浏览器：</dt>
            <dd className="inline break-all font-mono">{detail.userAgent}</dd>
          </div>
        ) : null}
        {detail.sentryEventId ? (
          <div>
            <dt className="inline">Sentry：</dt>
            <dd className="inline font-mono">{detail.sentryEventId}</dd>
          </div>
        ) : null}
      </dl>
      <div className="w-40">
        <SettingSelect
          label="状态"
          value={detail.status}
          options={STATUS_OPTIONS}
          onChange={changeStatus}
          disabled={action.busy !== null}
        />
      </div>
      <section aria-label="回复记录" className="grid gap-2">
        {detail.replies.map((item) => (
          <div
            key={item.id}
            className="rounded-md border border-primary/30 bg-primary/5 p-3 text-sm"
          >
            <p className="whitespace-pre-wrap break-words">{item.content}</p>
            <div className="mt-1 text-xs text-muted-foreground">
              {item.author?.name ?? "管理员"} · {formatShortDateTime(item.createdAt)}
            </div>
          </div>
        ))}
      </section>
      <form onSubmit={(event) => void submit(event)} className="grid gap-1.5">
        <Label htmlFor={replyId}>回复</Label>
        <Textarea
          id={replyId}
          value={reply}
          maxLength={FEEDBACK_REPLY_MAX_LENGTH}
          onChange={(event) => setReply(event.target.value)}
          placeholder="用户会在「我的反馈」里看到这条回复"
        />
        <div className="flex items-center justify-between gap-3">
          {action.error ? (
            <p role="alert" className="text-sm text-destructive">
              {action.error}
            </p>
          ) : (
            <span className="text-xs text-muted-foreground tabular-nums">
              {reply.length}/{FEEDBACK_REPLY_MAX_LENGTH}
            </span>
          )}
          <Button
            type="submit"
            disabled={!reply.trim() || action.busy === "status"}
            loading={action.busy === "reply"}
          >
            发送回复
          </Button>
        </div>
      </form>
    </div>
  );
}

function FeedbackLoader({ id, onChanged }: { id: string; onChanged: () => void }) {
  const query = useAdminQuery(
    `feedback:${id}`,
    () => api.admin.feedback.get({ id }),
    "反馈加载失败"
  );
  // 回复与改状态直接返回新数据，覆盖在读取结果之上，不必重新请求。
  const [override, setOverride] = useState<AdminFeedbackDetail | null>(null);
  const detail = override ?? query.data;
  return (
    <>
      <QueryState
        loading={query.loading}
        error={query.error}
        empty={false}
        hasData={Boolean(detail)}
        onRetry={query.reload}
        emptyText=""
      />
      {detail ? (
        <FeedbackThread
          detail={detail}
          onChanged={(next) => {
            setOverride(next);
            onChanged();
          }}
        />
      ) : null}
    </>
  );
}

export function FeedbackPanel() {
  const [status, setStatus] = useState("open");
  const [kind, setKind] = useState("");
  const [offset, setOffset] = useState(0);
  const [open, setOpen] = useState<{ id: string; title: string } | null>(null);
  const input = {
    ...(status ? { status: status as FeedbackStatus } : {}),
    ...(kind ? { kind: kind as FeedbackKind } : {}),
    limit: LIMIT,
    offset,
  };
  const list = useAdminQuery(
    `feedback:${JSON.stringify(input)}`,
    () => api.admin.feedback.list(input),
    "反馈列表加载失败"
  );
  const items = list.data?.items ?? [];

  return (
    <div>
      <AdminToolbar
        title="反馈"
        count={list.data?.total ?? null}
        onReload={list.reload}
        loading={list.loading && Boolean(list.data)}
      >
        <div className="w-32">
          <SettingSelect
            label="状态"
            value={status}
            options={STATUS_FILTER}
            onChange={(value) => {
              setStatus(value);
              setOffset(0);
            }}
          />
        </div>
        <div className="w-32">
          <SettingSelect
            label="类型"
            value={kind}
            options={KIND_FILTER}
            onChange={(value) => {
              setKind(value);
              setOffset(0);
            }}
          />
        </div>
      </AdminToolbar>
      <QueryState
        loading={list.loading}
        error={list.error}
        empty={Boolean(list.data) && !items.length}
        hasData={Boolean(list.data)}
        onRetry={list.reload}
        emptyText="没有符合条件的反馈"
      />
      {items.length ? (
        <AdminTable label="反馈列表">
          <thead>
            <tr>
              <th scope="col">标题</th>
              <th scope="col">类型</th>
              <th scope="col">状态</th>
              <th scope="col">提交人</th>
              <th scope="col">提交时间</th>
              <th scope="col">最近回复</th>
            </tr>
          </thead>
          <tbody>
            {items.map((item) => (
              <tr key={item.id}>
                <td className="max-w-64">
                  <RowButton onClick={() => setOpen({ id: item.id, title: item.title })}>
                    <span className="block truncate">{item.title}</span>
                  </RowButton>
                </td>
                <td>{FEEDBACK_KIND_LABELS[item.kind]}</td>
                <td>
                  <Badge variant={FEEDBACK_STATUS_BADGE[item.status]} size="xs">
                    {FEEDBACK_STATUS_LABELS[item.status]}
                  </Badge>
                </td>
                <td>
                  <UserCell user={item.user} />
                </td>
                <td className="whitespace-nowrap tabular-nums text-muted-foreground">
                  {formatShortDateTime(item.createdAt)}
                </td>
                <td className="whitespace-nowrap tabular-nums text-muted-foreground">
                  {item.lastReplyAt ? formatShortDateTime(item.lastReplyAt) : "—"}
                </td>
              </tr>
            ))}
          </tbody>
        </AdminTable>
      ) : null}
      <Pager offset={offset} limit={LIMIT} total={list.data?.total ?? 0} onChange={setOffset} />
      <Dialog
        open={open !== null}
        onOpenChange={(next) => {
          if (!next) setOpen(null);
        }}
      >
        <DialogContent className="sm:max-w-2xl">
          <DialogHeader>
            <DialogTitle className="break-words leading-snug">{open?.title}</DialogTitle>
            <DialogDescription>
              回复后用户侧出现未读；待处理的反馈随之转为处理中。
            </DialogDescription>
          </DialogHeader>
          {open ? <FeedbackLoader key={open.id} id={open.id} onChanged={list.reload} /> : null}
        </DialogContent>
      </Dialog>
    </div>
  );
}
