import { useCallback, useEffect, useState } from "react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/Dialog";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/Tabs";
import { api, apiErrorMessage } from "@/lib/Api";
import type { OriginPoint } from "@/lib/motion/Origin";
import { useAccountStore } from "@/stores/UseAccountStore";
import { PANEL } from "./FeedbackShared";
import { AnonymousFeedbackPanel, FeedbackForm, type FeedbackDraft } from "./FeedbackForm";
import { MyFeedbackPanel, type ListState } from "./MyFeedback";

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
    <DialogContent data-agent-sensitive className="sm:max-w-xl">
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
        // min-w-0：弹窗本体是 grid，标签页作为网格项默认不小于内容最小宽度，
        // 列表标题单行截断的全文宽度会把整块撑出弹窗右缘（手机上最明显）。
        <Tabs
          className="min-w-0"
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
                <>
                  <span
                    aria-hidden="true"
                    className="ml-1.5 rounded-full bg-destructive px-1.5 text-2xs leading-4 text-destructive-foreground tabular-nums"
                  >
                    {unread}
                  </span>
                  <span className="sr-only">，{unread} 条未读回复</span>
                </>
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
