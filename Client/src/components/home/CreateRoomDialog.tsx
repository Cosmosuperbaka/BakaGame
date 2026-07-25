import { useState, useEffect } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { Label } from "@/components/ui/label";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
  DialogDescription,
} from "@/components/ui/dialog";
import { useGameStore } from "@/stores/useGameStore";

export interface CreateRoomDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  defaultName: string;
  onCreate: (params: {
    name: string;
    visibility: "public" | "private";
    password?: string;
    allowSpectators: boolean;
  }) => Promise<void>;
}

export function CreateRoomDialog({
  open,
  onOpenChange,
  defaultName,
  onCreate,
}: CreateRoomDialogProps) {
  const [roomName, setRoomName] = useState(defaultName);
  const [isPrivate, setIsPrivate] = useState(false);
  const [password, setPassword] = useState("");
  const [allowSpectators, setAllowSpectators] = useState(true);
  const [loading, setLoading] = useState(false);
  const addToast = useGameStore((state) => state.addToast);

  useEffect(() => {
    if (open) {
      setRoomName(defaultName);
      setIsPrivate(false);
      setPassword("");
      setAllowSpectators(true);
    }
  }, [open, defaultName]);

  const handleCreate = async () => {
    if (isPrivate && !password.trim()) {
      addToast("私密房间需要设置密码", "error");
      return;
    }
    setLoading(true);
    try {
      await onCreate({
        name: roomName || "新房间",
        visibility: isPrivate ? "private" : "public",
        password: isPrivate ? password : undefined,
        allowSpectators,
      });
    } finally {
      setLoading(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>创建房间</DialogTitle>
          <DialogDescription>设置房间参数</DialogDescription>
        </DialogHeader>
        <div className="space-y-5">
          <div className="space-y-2">
            <Label className="text-sm">房间名称</Label>
            <Input
              value={roomName}
              onChange={(e) => setRoomName(e.target.value)}
              placeholder="输入房间名称"
              className="h-10"
            />
          </div>
          <div className="flex items-center justify-between py-1">
            <Label className="text-sm">私密房间</Label>
            <Switch checked={isPrivate} onCheckedChange={setIsPrivate} />
          </div>
          <AnimatePresence>
            {isPrivate && (
              <motion.div
                initial={{ height: 0, opacity: 0 }}
                animate={{ height: "auto", opacity: 1 }}
                exit={{ height: 0, opacity: 0 }}
                transition={{ duration: 0.25, ease: "easeInOut" }}
                className="overflow-hidden"
              >
                <div className="space-y-2 pb-1">
                  <Label className="text-sm">房间密码</Label>
                  <Input
                    type="password"
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    placeholder="设置房间密码"
                    className="h-10"
                  />
                </div>
              </motion.div>
            )}
          </AnimatePresence>
          <div className="flex items-center justify-between py-1">
            <Label className="text-sm">允许旁观</Label>
            <Switch checked={allowSpectators} onCheckedChange={setAllowSpectators} />
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            取消
          </Button>
          <Button onClick={handleCreate} disabled={loading}>
            {loading ? "创建中..." : "创建"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
