import { useEffect, useRef, useState } from "react";
import { ArrowLeft } from "lucide-react";
import type { FeedbackDetail, FeedbackSummary } from "@bakagame/shared";
import { Badge } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import { Spinner } from "@/components/ui/Spinner";
import { api, apiErrorMessage } from "@/lib/Api";
import {
  FEEDBACK_KIND_LABELS,
  FEEDBACK_STATUS_BADGE,
  FEEDBACK_STATUS_LABELS,
} from "@/lib/FeedbackLabels";
import { cn } from "@/lib/Utils";
import { FormAlert } from "./FormAlert";
import { Time } from "./FeedbackShared";

export type ListState =
  | { status: "loading" }
  | { status: "ready"; items: FeedbackSummary[] }
  | { status: "error"; message: string };

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
        // 负外边距抵掉 ghost 的内边距，箭头与下方标题左缘对齐（与关于页、抽屉的返回按钮同写法）。
        className="-ml-2 justify-self-start px-2"
        onClick={onBack}
      >
        <ArrowLeft />
        返回列表
      </Button>
      {error ? (
        <FormAlert>{error}</FormAlert>
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
            {/* 窄屏标题另起一行占满宽度：挤在两枚徽章右边会被压成一列三四字的窄条。 */}
            <h3 className="min-w-0 flex-1 basis-full font-semibold break-words sm:basis-0">
              {detail.title}
            </h3>
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

/** 「我的反馈」：列表、详情与刚提交成功的提示。 */
export function MyFeedbackPanel({
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
        <FormAlert>{list.message}</FormAlert>
      ) : list.items.length === 0 ? (
        // 空列表与站内其它空状态同一种虚线框（依赖清单、事件区、战绩），不是一行悬在空白里的裸字。
        <p className="rounded-md border border-dashed p-6 text-center text-sm text-muted-foreground">
          还没有提交过反馈
        </p>
      ) : (
        <ul className="grid grid-cols-1 gap-2">
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
                      <>
                        <span
                          aria-hidden="true"
                          className="h-2 w-2 shrink-0 rounded-full bg-destructive"
                        />
                        <span className="sr-only">有新回复，</span>
                      </>
                    ) : null}
                    <span className="truncate text-sm font-medium">{item.title}</span>
                  </span>
                  <span className="mt-1 flex items-center gap-2 text-xs text-muted-foreground">
                    {FEEDBACK_KIND_LABELS[item.kind]}
                    <span aria-hidden="true">·</span>
                    <Time value={item.lastReplyAt ?? item.createdAt} />
                  </span>
                </span>
                <Badge variant={FEEDBACK_STATUS_BADGE[item.status]} size="xs" className="shrink-0">
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
