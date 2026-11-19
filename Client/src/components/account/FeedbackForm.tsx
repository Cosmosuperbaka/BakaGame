import { useCallback, useEffect, useId, useRef, useState, type FormEvent } from "react";
import { useReducedMotion } from "framer-motion";
import { FEEDBACK_CONTENT_MAX_LENGTH, FEEDBACK_TITLE_MAX_LENGTH } from "@bakagame/shared/values";
import type { FeedbackKind } from "@bakagame/shared";
import { Button } from "@/components/ui/Button";
import { DialogFooter } from "@/components/ui/Dialog";
import { Label } from "@/components/ui/Label";
import { SegmentedControl } from "@/components/ui/SegmentedControl";
import { Textarea } from "@/components/ui/Textarea";
import { SettingsFields } from "@/components/common/room/settings/Layout";
import { SettingTextField } from "@/components/common/room/settings/TextFields";
import { api, apiErrorMessage } from "@/lib/Api";
import { cn } from "@/lib/Utils";
import { FormAlert } from "./FormAlert";
import { PANEL } from "./FeedbackShared";

/** 游客填好的反馈内容：跨登录弹窗保留，登录成功后自动提交。 */
export interface FeedbackDraft {
  kind: FeedbackKind;
  title: string;
  content: string;
}

export function FeedbackForm({
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
  const confirmRef = useRef<HTMLDivElement>(null);
  const submitButtonRef = useRef<HTMLButtonElement>(null);
  const wasConfirming = useRef(false);
  const reducedMotion = useReducedMotion();

  // 二次确认框出现在表单底部，定高滚动区里常常落在可视范围外：出现时把它挪进来。
  // 平滑滚过去，读得出确认框在表单下方；减弱动效时直接到位。
  useEffect(() => {
    if (confirming)
      confirmRef.current?.scrollIntoView?.({
        block: "nearest",
        behavior: reducedMotion ? "auto" : "smooth",
      });
  }, [confirming, reducedMotion]);
  // 点中的「匿名提交」会随确认条替换而卸载，焦点不处理就掉回 body：
  // 出现时交给确认条（读屏读出问句），收起时回到「匿名提交」，键盘用户不必重新找位置。
  useEffect(() => {
    if (confirming) {
      confirmRef.current?.focus({ preventScroll: true });
    } else if (wasConfirming.current) {
      submitButtonRef.current?.focus({ preventScroll: true });
    }
    wasConfirming.current = confirming;
  }, [confirming]);
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
          {/* 三个字段的标签同一口径：设置表单的衬线 sm 常规字重（SettingTextField 的「标题」就是这样）。 */}
          <span id={kindLabelId} className="font-serif text-sm leading-snug">
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
          <Label htmlFor={contentId} className="font-serif leading-snug font-normal">
            详细说明
          </Label>
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
      {error ? <FormAlert>{error}</FormAlert> : null}
      {guest && confirming ? (
        <div
          ref={confirmRef}
          role="alertdialog"
          aria-labelledby={confirmId}
          tabIndex={-1}
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
          <Button ref={submitButtonRef} type="submit" disabled={!ready} loading={busy}>
            {guest ? "匿名提交" : "提交反馈"}
          </Button>
        </DialogFooter>
      )}
    </form>
  );
}

/** 未登录时的反馈面板：只提交，不显示列表与详情。 */
export function AnonymousFeedbackPanel({
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
