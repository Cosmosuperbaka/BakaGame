import type { ReactNode } from "react";
import { motion } from "framer-motion";
import { Loader2 } from "lucide-react";
import { Button } from "@/components/ui/Button";
import { Input } from "@/components/ui/Input";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/Dialog";
import { duration, ease, spinner } from "@/lib/Motion";

/**
 * 进房前的三种状态：加入中、需要用户名、需要密码。
 * 三个游戏的分享链接进房都走这里，弹窗关闭即放弃进房。
 */
export function RoomJoinGate({
  roomId,
  needsName,
  needsPassword,
  nameDraft,
  onNameDraftChange,
  onConfirmName,
  passwordDraft,
  onPasswordDraftChange,
  onConfirmPassword,
  onExit,
  nameMaxLength = 20,
  children,
}: {
  roomId: string;
  needsName: boolean;
  needsPassword: boolean;
  nameDraft: string;
  onNameDraftChange: (value: string) => void;
  onConfirmName: () => void;
  passwordDraft: string;
  onPasswordDraftChange: (value: string) => void;
  onConfirmPassword: () => void;
  /** 放弃进房、回大厅 */
  onExit: () => void;
  nameMaxLength?: number;
  /** 页面级的 Seo 等不可见节点 */
  children?: ReactNode;
}) {
  return (
    <div className="flex h-full min-h-0 items-center justify-center overflow-hidden bg-background">
      {children}
      {!needsName && !needsPassword ? (
        <motion.div
          role="status"
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          transition={{ duration: duration.base, ease: ease.out }}
          className="flex flex-col items-center gap-3"
        >
          <motion.span {...spinner} className="inline-flex text-primary" aria-hidden="true">
            <Loader2 className="h-8 w-8" />
          </motion.span>
          <span className="text-sm text-muted-foreground">正在加入房间...</span>
        </motion.div>
      ) : null}

      <Dialog open={needsName} onOpenChange={(open) => { if (!open) onExit(); }}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>设置用户名</DialogTitle>
            <DialogDescription>进入房间 &ldquo;{roomId}&rdquo; 前先取个名字，其他玩家会看到它。</DialogDescription>
          </DialogHeader>
          <form className="grid gap-4" onSubmit={(event) => { event.preventDefault(); onConfirmName(); }}>
            <Input
              autoFocus
              aria-label="用户名"
              value={nameDraft}
              onChange={(event) => onNameDraftChange(event.target.value)}
              placeholder="用户名"
              maxLength={nameMaxLength}
            />
            <DialogFooter>
              <Button type="button" variant="ghost" onClick={onExit}>返回大厅</Button>
              <Button type="submit" disabled={!nameDraft.trim()}>进入房间</Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>

      <Dialog open={needsPassword} onOpenChange={(open) => { if (!open) onExit(); }}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>输入房间密码</DialogTitle>
            <DialogDescription>该链接指向一个私密房间。</DialogDescription>
          </DialogHeader>
          <form className="grid gap-4" onSubmit={(event) => { event.preventDefault(); onConfirmPassword(); }}>
            <Input
              autoFocus
              type="password"
              aria-label="房间密码"
              value={passwordDraft}
              onChange={(event) => onPasswordDraftChange(event.target.value)}
              placeholder="请输入密码"
            />
            <DialogFooter>
              <Button type="button" variant="ghost" onClick={onExit}>返回大厅</Button>
              <Button type="submit" disabled={!passwordDraft.trim()}>加入房间</Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    </div>
  );
}
