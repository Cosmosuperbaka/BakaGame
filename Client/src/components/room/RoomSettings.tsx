import { useState } from "react";
import { AnimatePresence, motion } from "framer-motion";
import { Minus, Plus, Users } from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
  DialogDescription,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { collapsible, duration, ease, spring, type OriginPoint } from "@/lib/motion";
import { useGameStore } from "@/stores/useGameStore";
import type { RoomSnapshot } from "@/types";

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** 设置按钮位置，弹窗由此展开 */
  origin?: OriginPoint | null;
}

export function RoomSettings({ open, onOpenChange, origin }: Props) {
  const snapshot = useGameStore((s) => s.snapshot);

  if (!snapshot) return null;

  // 表单随弹窗挂载/卸载，状态由初始值直接建立，无需打开后再同步。
  return (
    <Dialog open={open} onOpenChange={onOpenChange} origin={origin}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>房间设置</DialogTitle>
          <DialogDescription>仅在未开局时生效</DialogDescription>
        </DialogHeader>
        <SettingsForm snapshot={snapshot} onOpenChange={onOpenChange} />
      </DialogContent>
    </Dialog>
  );
}

interface SettingsFormProps {
  snapshot: RoomSnapshot;
  onOpenChange: (open: boolean) => void;
}

/** 步进数字：沿增减方向滑入滑出，方向由 custom 传入 */
const stepValue = {
  initial: (direction: number) => ({ y: direction > 0 ? 14 : -14, opacity: 0 }),
  animate: { y: 0, opacity: 1, transition: spring.snap },
  exit: (direction: number) => ({
    y: direction > 0 ? -14 : 14,
    opacity: 0,
    transition: { duration: duration.instant, ease: ease.inOut },
  }),
};

function SettingsForm({ snapshot, onOpenChange }: SettingsFormProps) {
  const sendCommand = useGameStore((s) => s.sendCommand);
  const addToast = useGameStore((s) => s.addToast);

  const [name, setName] = useState(snapshot.name);
  const [isPrivate, setIsPrivate] = useState(snapshot.visibility === "private");
  const [password, setPassword] = useState("");
  const [allowSpectators, setAllowSpectators] = useState(snapshot.allowSpectators);
  const [undercoverCount, setUndercoverCount] = useState(
    snapshot.settings.roleConfig.undercoverCount,
  );
  // 记录最近一次步进方向，供数字进出动画取向
  const [stepDirection, setStepDirection] = useState(1);
  const [hasAngel, setHasAngel] = useState(snapshot.settings.roleConfig.hasAngel);
  const [hasBlank, setHasBlank] = useState(snapshot.settings.roleConfig.hasBlank);

  const limits = snapshot.roleLimits;
  const activePlayers = snapshot.players.filter(
    (p) => p.membership === "active"
  ).length;
  // 玩家不足 4 人时阵营配置仍可调整（上限已由服务端退回 1），
  // 不到 4 人无法开局本身就是约束，无需在设置界面重复提示。

  const handleSave = async () => {
    try {
      await sendCommand("room.updateSettings", {
        name: name || undefined,
        visibility: isPrivate ? "private" : "public",
        password: isPrivate ? password || undefined : "",
        allowSpectators,
        roleConfig: {
          undercoverCount: Math.max(
            1,
            Math.min(undercoverCount, Math.max(1, limits.maxUndercoverCount))
          ),
          hasAngel: limits.canEnableAngel && hasAngel,
          hasBlank: limits.canEnableBlank && hasBlank,
        },
      });
      onOpenChange(false);
      addToast("设置已保存", "success");
    } catch (e) {
      addToast((e as { message: string }).message, "error");
    }
  };

  return (
    <>
      <div className="space-y-5">
          <div className="space-y-1.5">
            <Label>房间名称</Label>
            <Input value={name} onChange={(e) => setName(e.target.value)} />
          </div>

          <div className="flex items-center justify-between">
            <Label>私密房间</Label>
            <Switch checked={isPrivate} onCheckedChange={setIsPrivate} />
          </div>
          <AnimatePresence initial={false}>
            {isPrivate && (
              <motion.div
                variants={collapsible}
                initial="initial"
                animate="animate"
                exit="exit"
                className="overflow-hidden"
              >
                <div className="space-y-1.5 pt-1">
                  <Label>密码</Label>
                  <Input
                    type="password"
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    placeholder="留空则保留当前密码"
                  />
                </div>
              </motion.div>
            )}
          </AnimatePresence>

          <div className="flex items-center justify-between">
            <Label>允许旁观</Label>
            <Switch
              checked={allowSpectators}
              onCheckedChange={setAllowSpectators}
            />
          </div>

          {/* 阵营配置 */}
          <div className="border-t pt-4">
            <div className="flex items-center justify-between mb-3">
              <h4 className="text-sm font-semibold">阵营配置</h4>
              <span className="inline-flex items-center gap-1 text-xs text-muted-foreground">
                <Users className="h-3.5 w-3.5" />
                {activePlayers} 名玩家
              </span>
            </div>

            <div className="flex items-center justify-between mb-3">
              <Label>
                卧底人数
              </Label>
              <div className="flex items-center gap-2">
                <Button
                  variant="outline"
                  size="icon"
                  className="h-7 w-7"
                  aria-label="减少卧底人数"
                  onClick={() => {
                    setStepDirection(-1);
                    setUndercoverCount((c) => Math.max(1, c - 1));
                  }}
                  disabled={undercoverCount <= 1}
                >
                  <Minus className="h-3 w-3" />
                </Button>
                {/* 数字随增减方向进出，让步进读作推动而非替换 */}
                <span className="relative flex h-5 w-6 items-center justify-center overflow-hidden">
                  <AnimatePresence mode="popLayout" initial={false} custom={stepDirection}>
                    <motion.span
                      key={undercoverCount}
                      custom={stepDirection}
                      variants={stepValue}
                      initial="initial"
                      animate="animate"
                      exit="exit"
                      className="text-sm font-medium tabular-nums"
                    >
                      {undercoverCount}
                    </motion.span>
                  </AnimatePresence>
                </span>
                <Button
                  variant="outline"
                  size="icon"
                  className="h-7 w-7"
                  aria-label="增加卧底人数"
                  onClick={() => {
                    setStepDirection(1);
                    setUndercoverCount((c) =>
                      Math.min(limits.maxUndercoverCount, c + 1)
                    );
                  }}
                  disabled={undercoverCount >= limits.maxUndercoverCount}
                >
                  <Plus className="h-3 w-3" />
                </Button>
                <span className="text-xs text-muted-foreground min-w-[3.5rem]">
                  上限 {limits.maxUndercoverCount}
                </span>
              </div>
            </div>

            <div className="flex items-center justify-between mb-3">
              <Label className={!limits.canEnableAngel ? "opacity-50" : ""}>
                天使
                {!limits.canEnableAngel && (
                  <span className="text-[10px] text-muted-foreground ml-1">
                    (10 人开启)
                  </span>
                )}
              </Label>
              <Switch
                checked={hasAngel}
                onCheckedChange={setHasAngel}
                disabled={!limits.canEnableAngel}
              />
            </div>

            <div className="flex items-center justify-between">
              <Label className={!limits.canEnableBlank ? "opacity-50" : ""}>
                白板
                {!limits.canEnableBlank && (
                  <span className="text-[10px] text-muted-foreground ml-1">
                    (8 人开启)
                  </span>
                )}
              </Label>
              <Switch
                checked={hasBlank}
                onCheckedChange={setHasBlank}
                disabled={!limits.canEnableBlank}
              />
            </div>
          </div>
        </div>
      <DialogFooter>
        <Button variant="outline" onClick={() => onOpenChange(false)}>
          取消
        </Button>
        <Button onClick={handleSave}>保存</Button>
      </DialogFooter>
    </>
  );
}
