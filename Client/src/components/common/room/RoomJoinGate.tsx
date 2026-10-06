import { useId, type ReactNode } from "react";
import { motion } from "framer-motion";
import { Button } from "@/components/ui/Button";
import { Input } from "@/components/ui/Input";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/Dialog";
import { Spinner } from "@/components/ui/Spinner";
import { duration, ease } from "@/lib/Motion";

/** 进房弹窗里一次加入失败的文案；`invalid` 只在确属密码错误时标红输入框。 */
export interface RoomPasswordError {
  message: string;
  invalid: boolean;
}

/**
 * 进房输入密码的输入框：分享链接进房（`RoomJoinGate`）与大厅点开带锁房间（`JoinPasswordDialog`）共用这一种写法。
 * 失败文案写在框下并经 `aria-describedby` 关联；只有密码本身不对才标 `aria-invalid`，其余失败（次数过多等）只给文案。
 */
export function RoomPasswordField({ value, onChange, disabled = false, error }: {
  value: string;
  onChange: (value: string) => void;
  disabled?: boolean;
  error?: RoomPasswordError | null;
}) {
  const errorId = useId();
  return (
    <div className="grid gap-1.5">
      <Input
        autoFocus
        type="password"
        aria-label="房间密码"
        value={value}
        disabled={disabled}
        onChange={(event) => onChange(event.target.value)}
        placeholder="请输入密码"
        aria-invalid={error?.invalid || undefined}
        aria-describedby={error ? errorId : undefined}
        className="h-10"
      />
      {error ? <p id={errorId} role="alert" className="text-xs text-destructive">{error.message}</p> : null}
    </div>
  );
}

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
  pending = false,
  passwordError,
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
  /** 确认后请求在途：确认按钮转圈并禁用，防止重复提交 */
  pending?: boolean;
  /** 上一次密码加入失败的文案，写在密码框下方 */
  passwordError?: RoomPasswordError | null;
  /** 页面级的 Seo 等不可见节点 */
  children?: ReactNode;
}) {
  return (
    <div className="flex h-full min-h-0 items-center justify-center overflow-hidden">
      {children}
      {!needsName && !needsPassword ? (
        <motion.div
          role="status"
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          transition={{ duration: duration.base, ease: ease.out }}
          className="flex flex-col items-center gap-3"
        >
          <Spinner className="size-8 text-primary" />
          <span className="text-sm text-muted-foreground">正在加入房间...</span>
        </motion.div>
      ) : null}

      <Dialog open={needsName} onOpenChange={(open) => { if (!open) onExit(); }}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>设置用户名</DialogTitle>
            <DialogDescription>进入房间 &ldquo;{roomId}&rdquo; 前先取个名字，其他玩家会看到它。</DialogDescription>
          </DialogHeader>
          <form className="grid gap-4" onSubmit={(event) => { event.preventDefault(); if (nameDraft.trim() && !pending) onConfirmName(); }}>
            <Input
              autoFocus
              aria-label="用户名"
              value={nameDraft}
              onChange={(event) => onNameDraftChange(event.target.value)}
              placeholder="用户名"
              maxLength={nameMaxLength}
              className="h-10"
            />
            <DialogFooter>
              <Button type="button" variant="outline" onClick={onExit}>返回大厅</Button>
              <Button type="submit" disabled={!nameDraft.trim()} loading={pending}>进入房间</Button>
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
          <form className="grid gap-4" onSubmit={(event) => { event.preventDefault(); if (passwordDraft.trim() && !pending) onConfirmPassword(); }}>
            <RoomPasswordField value={passwordDraft} onChange={onPasswordDraftChange} error={passwordError} />
            <DialogFooter>
              <Button type="button" variant="outline" onClick={onExit}>返回大厅</Button>
              <Button type="submit" disabled={!passwordDraft.trim()} loading={pending}>加入房间</Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    </div>
  );
}
