import { useState, useEffect } from "react";
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
import { useGame } from "@/contexts/GameContext";

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

export function RoomSettings({ open, onOpenChange }: Props) {
  const { state, sendCommand, addToast } = useGame();
  const snapshot = state.snapshot;

  const [name, setName] = useState("");
  const [isPrivate, setIsPrivate] = useState(false);
  const [password, setPassword] = useState("");
  const [allowSpectators, setAllowSpectators] = useState(true);
  const [undercoverCount, setUndercoverCount] = useState(1);
  const [hasAngel, setHasAngel] = useState(false);
  const [hasBlank, setHasBlank] = useState(false);

  useEffect(() => {
    if (snapshot && open) {
      setName(snapshot.name);
      setIsPrivate(snapshot.visibility === "private");
      setAllowSpectators(snapshot.allowSpectators);
      setUndercoverCount(snapshot.settings.roleConfig.undercoverCount);
      setHasAngel(snapshot.settings.roleConfig.hasAngel);
      setHasBlank(snapshot.settings.roleConfig.hasBlank);
      setPassword("");
    }
  }, [snapshot, open]);

  if (!snapshot) return null;

  const limits = snapshot.roleLimits;
  const activePlayers = snapshot.players.filter(
    (p) => p.membership === "active"
  ).length;
  // 玩家不足 4 人（加出题人 5 人）时禁用身份编辑，但其它设置仍可保存。
  const roleEditingDisabled = limits.maxUndercoverCount < 1;

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
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>房间设置</DialogTitle>
          <DialogDescription>修改房间配置（仅在未开局时生效）</DialogDescription>
        </DialogHeader>
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
                initial={{ height: 0, opacity: 0 }}
                animate={{ height: "auto", opacity: 1 }}
                exit={{ height: 0, opacity: 0 }}
                transition={{ duration: 0.2, ease: "easeOut" }}
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
                {activePlayers} 名正式玩家
              </span>
            </div>
            {roleEditingDisabled && (
              <p className="text-xs text-amber-600 bg-amber-50 dark:bg-amber-950/30 rounded-md px-3 py-2 mb-3 leading-relaxed">
                正式玩家不足 4 人，阵营人数暂不可调整。其它设置仍可保存。
              </p>
            )}

            <div className="flex items-center justify-between mb-3">
              <Label className={roleEditingDisabled ? "opacity-50" : ""}>
                卧底人数
              </Label>
              <div className="flex items-center gap-2">
                <Button
                  variant="outline"
                  size="icon"
                  className="h-7 w-7"
                  onClick={() =>
                    setUndercoverCount((c) => Math.max(1, c - 1))
                  }
                  disabled={roleEditingDisabled || undercoverCount <= 1}
                >
                  <Minus className="h-3 w-3" />
                </Button>
                <span className="w-6 text-center text-sm font-medium">
                  {undercoverCount}
                </span>
                <Button
                  variant="outline"
                  size="icon"
                  className="h-7 w-7"
                  onClick={() =>
                    setUndercoverCount((c) =>
                      Math.min(
                        Math.max(1, limits.maxUndercoverCount),
                        c + 1
                      )
                    )
                  }
                  disabled={
                    roleEditingDisabled ||
                    undercoverCount >= Math.max(1, limits.maxUndercoverCount)
                  }
                >
                  <Plus className="h-3 w-3" />
                </Button>
                <span className="text-xs text-muted-foreground min-w-[3.5rem]">
                  上限 {Math.max(1, limits.maxUndercoverCount)}
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
                disabled={roleEditingDisabled || !limits.canEnableAngel}
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
                disabled={roleEditingDisabled || !limits.canEnableBlank}
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
      </DialogContent>
    </Dialog>
  );
}
