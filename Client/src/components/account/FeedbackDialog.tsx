import { useCallback, useEffect, useId, useRef, useState, type FormEvent } from "react";
import { ArrowLeft } from "lucide-react";
import {
  FEEDBACK_CONTENT_MAX_LENGTH,
  FEEDBACK_TITLE_MAX_LENGTH,
  type FeedbackDetail,
  type FeedbackKind,
  type FeedbackSummary,
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
import { Label } from "@/components/ui/Label";
import { SegmentedControl } from "@/components/ui/SegmentedControl";
import { Spinner } from "@/components/ui/Spinner";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/Tabs";
import { Textarea } from "@/components/ui/Textarea";
import { Hint } from "@/components/ui/Tooltip";
import { SettingTextField, SettingsFields } from "@/components/common/room/SettingFields";
import { api, apiErrorMessage } from "@/lib/Api";
import {
  FEEDBACK_KIND_LABELS,
  FEEDBACK_STATUS_BADGE,
  FEEDBACK_STATUS_LABELS,
} from "@/lib/FeedbackLabels";
import type { OriginPoint } from "@/lib/Motion";
import { formatAbsoluteTime, formatRelativeTime } from "@/lib/Time";
import { cn } from "@/lib/Utils";
import { useAccountStore } from "@/stores/UseAccountStore";

const PANEL = "scrollbar-hidden h-[min(56vh,30rem)] overflow-y-auto overscroll-contain";

type ListState =
  | { status: "loading" }
  | { status: "ready"; items: FeedbackSummary[] }
  | { status: "error"; message: string };

/** 游客填好的反馈内容：跨登录弹窗保留，登录成功后自动提交。 */
export interface FeedbackDraft {
  kind: FeedbackKind;
  title: string;
  content: string;
}

function Time({ value }: { value: string }) {
  return (
    <Hint label={formatAbsoluteTime(value)}>
      <time dateTime={value}>{formatRelativeTime(value)}</time>
    </Hint>
  );
}

function FeedbackForm({
  onCreated,
  guest = false,
  draft = null,
  autoSubmit = false,
  onAutoSubmitted,
  onRequestLogin,
}: {
  onCreated: () => void;
  guest?: boolean;
  draft?: FeedbackDraft | null;
  autoSubmit?: boolean;
  onAutoSubmitted?: () => void;
  onRequestLogin?: (draft: FeedbackDraft) => void;
}) {
  const [kind, setKind] = useState<FeedbackKind>(draft?.kind ?? "suggestion");
  const [title, setTitle] = useState(draft?.title ?? "");
  const [content, setContent] = useState(draft?.content ?? "");
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const contentId = useId();
  const kindLabelId = useId();
  const confirmId = useId();
  const autoStarted = useRef(false);
  const ready = title.trim().length > 0 && content.trim().length > 0;

  const submit = useCallback(async () => {
    if (!ready || busy) return;
    setBusy(true);
    setError(null);
    try {
      await api.feedback.create({
        kind,
        title: title.trim(),
        content: content.trim(),
        page: window.location.pathname.slice(0, 255),
      });
      setTitle("");
      setContent("");
      setConfirming(false);
      onCreated();
    } catch (cause) {
      setError(apiErrorMessage(cause, "提交失败，请稍后重试"));
    } finally {
      setBusy(false);
    }
  }, [busy, content, kind, onCreated, ready, title]);

  // 登录成功后自动提交登录前填好的草稿；失败时保留内容供手动重试。
  useEffect(() => {
    if (!autoSubmit || autoStarted.current || !ready) return;
    autoStarted.current = true;
    onAutoSubmitted?.();
    void submit();
  }, [autoSubmit, onAutoSubmitted, ready, submit]);

  const handleSubmit = (event: FormEvent) => {
    event.preventDefault();
    if (guest && !confirming) {
      if (!ready || busy) return;
      setConfirming(true);
      return;
    }
    void submit();
  };

  return (
    <form onSubmit={handleSubmit} className="grid gap-4">
      <SettingsFields>
        <div className="flex items-center justify-between gap-3">
          <span id={kindLabelId} className="text-sm font-medium">
            类型
          </span>
          <SegmentedControl
            aria-labelledby={kindLabelId}
            value={kind}
            onValueChange={setKind}
            options={[
              { value: "suggestion", label: "建议" },
              { value: "bug", label: "问题" },
            ]}
          />
        </div>
        <SettingTextField
          label="标题"
          value={title}
          onChange={setTitle}
          placeholder={kind === "bug" ? "一句话描述遇到的问题" : "一句话概括你的建议"}
          maxLength={FEEDBACK_TITLE_MAX_LENGTH}
          inputClassName="h-10"
        />
        <div className="grid gap-1.5">
          <Label htmlFor={contentId}>详细说明</Label>
          <Textarea
            id={contentId}
            value={content}
            maxLength={FEEDBACK_CONTENT_MAX_LENGTH}
            onChange={(event) => setContent(event.target.value)}
            placeholder={kind === "bug" ? "在哪个游戏、做了什么操作、看到了什么" : "希望怎样改进"}
            className="min-h-32"
          />
          <span className="text-right text-xs text-muted-foreground tabular-nums">
            {content.length}/{FEEDBACK_CONTENT_MAX_LENGTH}
          </span>
        </div>
      </SettingsFields>
      {error ? (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      ) : null}
      {guest && confirming ? (
        <div
          role="alertdialog"
          aria-labelledby={confirmId}
          className="grid gap-2 rounded-md border border-border bg-muted/40 p-3"
        >
          <p id={confirmId} className="text-sm font-medium">
            是否确定提交匿名反馈？
          </p>
          <p className="text-xs text-muted-foreground">
            反馈的优先级可能较低，您也无法看到反馈的结果。
          </p>
          <div className="flex justify-end gap-2">
            <Button
              type="button"
              variant="outline"
              disabled={busy}
              onClick={() => {
                setConfirming(false);
                setError(null);
              }}
            >
              取消
            </Button>
            <Button type="submit" loading={busy}>
              确定提交
            </Button>
          </div>
        </div>
      ) : (
        <DialogFooter>
          {guest ? (
            <Button
              type="button"
              variant="outline"
              disabled={!ready || busy || !onRequestLogin}
              onClick={() =>
                onRequestLogin?.({ kind, title: title.trim(), content: content.trim() })
              }
            >
              登录并提交
            </Button>
          ) : null}
          <Button type="submit" disabled={!ready} loading={busy}>
            {guest ? "匿名提交" : "提交反馈"}
          </Button>
        </DialogFooter>
      )}
    </form>
  );
}

function FeedbackThread({
  id,
  onBack,
  onRead,
}: {
  id: string;
  onBack: () => void;
  onRead: () => void;
}) {
  const [detail, setDetail] = useState<FeedbackDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  // 只按反馈 ID 取详情：回调随列表状态变化，不能让它重新触发读取。
  const onReadRef = useRef(onRead);
  useEffect(() => {
    onReadRef.current = onRead;
  }, [onRead]);

  useEffect(() => {
    let alive = true;
    api.feedback.get({ id }).then(
      (value) => {
        if (!alive) return;
        setDetail(value);
        onReadRef.current();
      },
      (cause: unknown) => alive && setError(apiErrorMessage(cause, "反馈加载失败"))
    );
    return () => {
      alive = false;
    };
  }, [id]);

  return (
    <div className="grid gap-3">
      <Button
        type="button"
        variant="ghost"
        size="sm"
        className="justify-self-start"
        onClick={onBack}
      >
        <ArrowLeft />
        返回列表
      </Button>
      {error ? (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      ) : !detail ? (
        <div role="status" className="flex justify-center py-8">
          <Spinner className="size-5 text-muted-foreground" />
          <span className="sr-only">加载中</span>
        </div>
      ) : (
        <article className="grid gap-3">
          <header className="flex flex-wrap items-center gap-2">
            <Badge variant="outline" size="xs">
              {FEEDBACK_KIND_LABELS[detail.kind]}
            </Badge>
            <Badge variant={FEEDBACK_STATUS_BADGE[detail.status]} size="xs">
              {FEEDBACK_STATUS_LABELS[detail.status]}
            </Badge>
            <h3 className="min-w-0 flex-1 font-semibold break-words">{detail.title}</h3>
          </header>
          <p className="whitespace-pre-wrap break-words rounded-md border bg-card p-3 text-sm">
            {detail.content}
          </p>
          <div className="text-xs text-muted-foreground">
            提交于 <Time value={detail.createdAt} />
          </div>
          <section aria-label="管理员回复" className="grid gap-2">
            {detail.replies.length ? (
              detail.replies.map((reply) => (
                <div
                  key={reply.id}
                  className="rounded-md border border-primary/30 bg-primary/5 p-3 text-sm"
                >
                  <div className="mb-1 flex items-center justify-between gap-2 text-xs text-muted-foreground">
                    <span className="font-medium text-primary">管理员回复</span>
                    <Time value={reply.createdAt} />
                  </div>
                  <p className="whitespace-pre-wrap break-words">{reply.content}</p>
                </div>
              ))
            ) : (
              <p className="text-sm text-muted-foreground">暂无回复，处理后会在这里答复你。</p>
            )}
          </section>
        </article>
      )}
    </div>
  );
}

/**
 * 反馈弹窗：登录用户可提交并查看自己的反馈与管理员回复；游客可选匿名提交
 * （二次确认，不显示列表与结果）或登录后提交登录前填好的草稿
 * （见 Server/docs/Account.md §7）。登录用户打开详情即标记已读；
 * 有未读回复时默认落在「我的反馈」。
 */
export function FeedbackDialog({
  open,
  onOpenChange,
  origin,
  draft = null,
  autoSubmit = false,
  onAutoSubmitted,
  onRequestLogin,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  origin?: OriginPoint | null;
  /** 游客点「登录并提交」暂存的内容；登录成功后自动提交。 */
  draft?: FeedbackDraft | null;
  autoSubmit?: boolean;
  onAutoSubmitted?: () => void;
  onRequestLogin?: (draft: FeedbackDraft) => void;
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange} origin={origin}>
      <FeedbackDialogBody
        draft={draft}
        autoSubmit={autoSubmit}
        onAutoSubmitted={onAutoSubmitted}
        onRequestLogin={onRequestLogin}
      />
    </Dialog>
  );
}

/** 未登录时的反馈面板：只提交，不显示列表与详情。 */
function AnonymousFeedbackPanel({
  draft,
  onRequestLogin,
}: {
  draft: FeedbackDraft | null;
  onRequestLogin?: (draft: FeedbackDraft) => void;
}) {
  const [notice, setNotice] = useState<string | null>(null);
  return (
    <div className={cn(PANEL, "grid gap-3")}>
      {notice ? (
        <p
          role="status"
          className="rounded-md border border-success/40 bg-success/10 px-3 py-2 text-sm text-success"
        >
          {notice}
        </p>
      ) : null}
      <FeedbackForm
        guest
        draft={draft}
        onRequestLogin={onRequestLogin}
        onCreated={() => setNotice("已收到你的匿名反馈，感谢！")}
      />
    </div>
  );
}

/** 「我的反馈」：列表、详情与刚提交成功的提示。 */
function MyFeedbackPanel({
  list,
  selected,
  notice,
  onSelect,
  onBack,
  onRead,
}: {
  list: ListState;
  selected: string | null;
  notice: string | null;
  onSelect: (id: string) => void;
  onBack: () => void;
  onRead: () => void;
}) {
  return (
    <>
      {notice ? (
        <p
          role="status"
          className="mb-3 rounded-md border border-success/40 bg-success/10 px-3 py-2 text-sm text-success"
        >
          {notice}
        </p>
      ) : null}
      {selected ? (
        <FeedbackThread id={selected} onBack={onBack} onRead={onRead} />
      ) : list.status === "loading" ? (
        <div role="status" className="flex justify-center py-8">
          <Spinner className="size-5 text-muted-foreground" />
          <span className="sr-only">加载中</span>
        </div>
      ) : list.status === "error" ? (
        <p role="alert" className="text-sm text-destructive">
          {list.message}
        </p>
      ) : list.items.length === 0 ? (
        <p className="py-8 text-center text-sm text-muted-foreground">还没有提交过反馈</p>
      ) : (
        <ul className="grid gap-2">
          {list.items.map((item) => (
            <li key={item.id}>
              <button
                type="button"
                onClick={() => onSelect(item.id)}
                className={cn(
                  "flex w-full items-center gap-3 rounded-md border bg-card px-3 py-2.5 text-left transition-colors hover:bg-accent/40",
                  item.unread && "border-primary/40"
                )}
              >
                <span className="min-w-0 flex-1">
                  <span className="flex items-center gap-2">
                    {item.unread ? (
                      <span
                        aria-label="有新回复"
                        className="h-2 w-2 shrink-0 rounded-full bg-destructive"
                      />
                    ) : null}
                    <span className="truncate text-sm font-medium">{item.title}</span>
                  </span>
                  <span className="mt-1 flex items-center gap-2 text-xs text-muted-foreground">
                    {FEEDBACK_KIND_LABELS[item.kind]}
                    <span aria-hidden="true">·</span>
                    <Time value={item.lastReplyAt ?? item.createdAt} />
                  </span>
                </span>
                <Badge
                  variant={FEEDBACK_STATUS_BADGE[item.status]}
                  size="xs"
                  className="shrink-0"
                >
                  {FEEDBACK_STATUS_LABELS[item.status]}
                </Badge>
              </button>
            </li>
          ))}
        </ul>
      )}
    </>
  );
}

function FeedbackDialogBody({
  draft,
  autoSubmit,
  onAutoSubmitted,
  onRequestLogin,
}: {
  draft: FeedbackDraft | null;
  autoSubmit: boolean;
  onAutoSubmitted?: () => void;
  onRequestLogin?: (draft: FeedbackDraft) => void;
}) {
  const status = useAccountStore((state) => state.status);
  const signedIn = status === "signedIn";
  const unread = useAccountStore((state) => state.unreadFeedback);
  const setUnread = useAccountStore((state) => state.setUnreadFeedback);
  // 每次打开重新挂载：登录后待自动提交时落在提交页；否则有未读回复时落在「我的反馈」。
  const [tab, setTab] = useState<"create" | "mine">(() => {
    if (autoSubmit) return "create";
    const state = useAccountStore.getState();
    return state.status === "signedIn" && state.unreadFeedback > 0 ? "mine" : "create";
  });
  const [list, setList] = useState<ListState>({ status: "loading" });
  const [selected, setSelected] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const refresh = useCallback(() => {
    if (useAccountStore.getState().status !== "signedIn") return;
    api.feedback.listMine().then(
      ({ items, unread: count }) => {
        setList({ status: "ready", items });
        setUnread(count);
      },
      (cause: unknown) =>
        setList({ status: "error", message: apiErrorMessage(cause, "反馈列表加载失败") })
    );
  }, [setUnread]);

  useEffect(() => {
    if (!signedIn) return;
    refresh();
  }, [signedIn, refresh]);

  const markRead = useCallback(() => {
    if (list.status !== "ready") return;
    const items = list.items.map((item) =>
      item.id === selected ? { ...item, unread: false } : item
    );
    setList({ status: "ready", items });
    setUnread(items.filter((item) => item.unread).length);
  }, [list, selected, setUnread]);

  return (
    <DialogContent className="sm:max-w-xl">
      <DialogHeader>
        <DialogTitle>反馈</DialogTitle>
        <DialogDescription>
          {signedIn
            ? "建议与问题都会被认真看到，回复会出现在「我的反馈」里。"
            : "建议与问题都会被认真看到。"}
        </DialogDescription>
      </DialogHeader>
      {!signedIn ? (
        <AnonymousFeedbackPanel draft={draft} onRequestLogin={onRequestLogin} />
      ) : (
        <Tabs
          value={tab}
          onValueChange={(value) => {
            setTab(value as "create" | "mine");
            setSelected(null);
            setNotice(null);
          }}
        >
          <TabsList className="mb-4 w-full">
            <TabsTrigger value="create" className="flex-1">
              提交反馈
            </TabsTrigger>
            <TabsTrigger value="mine" className="flex-1">
              我的反馈
              {unread > 0 ? (
                <span
                  aria-label={`${unread} 条未读回复`}
                  className="ml-1.5 rounded-full bg-destructive px-1.5 text-2xs leading-4 text-destructive-foreground tabular-nums"
                >
                  {unread}
                </span>
              ) : null}
            </TabsTrigger>
          </TabsList>
          <TabsContent value="create" className={PANEL}>
            <FeedbackForm
              draft={autoSubmit ? draft : null}
              autoSubmit={autoSubmit}
              onAutoSubmitted={onAutoSubmitted}
              onCreated={() => {
                setNotice("已收到你的反馈，感谢！");
                setTab("mine");
                refresh();
              }}
            />
          </TabsContent>
          <TabsContent value="mine" className={PANEL}>
            <MyFeedbackPanel
              list={list}
              selected={selected}
              notice={notice}
              onSelect={setSelected}
              onBack={() => setSelected(null)}
              onRead={markRead}
            />
          </TabsContent>
        </Tabs>
      )}
    </DialogContent>
  );
}
