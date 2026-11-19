import type { ReactNode } from "react";
import { motion } from "framer-motion";
import { Input } from "@/components/ui/Input";
import {
  RoomPasswordField,
  type RoomPasswordError,
} from "@/components/common/room/RoomPasswordField";
import { Dialog, DialogContent } from "@/components/ui/Dialog";
import { FormDialog } from "@/components/common/FormDialog";
import { Spinner } from "@/components/ui/Spinner";
import { fadeSwap } from "@/lib/motion/NamedMoves";

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
          variants={fadeSwap}
          initial="initial"
          animate="animate"
          className="flex flex-col items-center gap-3"
        >
          <Spinner className="size-8 text-primary" />
          <span className="text-sm text-muted-foreground">正在加入房间...</span>
        </motion.div>
      ) : null}

      <Dialog
        open={needsName}
        onOpenChange={(open) => {
          if (!open) onExit();
        }}
      >
        <DialogContent>
          <FormDialog
            title="设置用户名"
            description={<>进入房间 &ldquo;{roomId}&rdquo; 前先取个名字，其他玩家会看到它。</>}
            cancelLabel="返回大厅"
            submitLabel="进入房间"
            onCancel={onExit}
            onSubmit={onConfirmName}
            submitDisabled={!nameDraft.trim()}
            pending={pending}
          >
            <Input
              autoFocus
              aria-label="用户名"
              value={nameDraft}
              onChange={(event) => onNameDraftChange(event.target.value)}
              placeholder="用户名"
              maxLength={nameMaxLength}
              className="h-10"
            />
          </FormDialog>
        </DialogContent>
      </Dialog>

      <Dialog
        open={needsPassword}
        onOpenChange={(open) => {
          if (!open) onExit();
        }}
      >
        <DialogContent>
          <FormDialog
            title="输入房间密码"
            description="该链接指向一个私密房间。"
            cancelLabel="返回大厅"
            submitLabel="加入房间"
            onCancel={onExit}
            onSubmit={onConfirmPassword}
            submitDisabled={!passwordDraft.trim()}
            pending={pending}
          >
            <RoomPasswordField
              value={passwordDraft}
              onChange={onPasswordDraftChange}
              error={passwordError}
            />
          </FormDialog>
        </DialogContent>
      </Dialog>
    </div>
  );
}
