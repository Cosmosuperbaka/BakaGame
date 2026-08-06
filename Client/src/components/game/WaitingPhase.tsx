import { useCallback, useEffect, useState } from "react";
import { motion, AnimatePresence } from "framer-motion";
import {
  Check, X, Gamepad2, Copy, Link, ChevronDown, Settings,
  Lock, Globe, Users, Minus, Plus,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { spring, collapsible, pressable } from "@/lib/motion";
import { PhaseHeader } from "@/components/game/PhaseHeader";
import { useGameStore } from "@/stores/useGameStore";
import { cn } from "@/lib/utils";
import type { RoomSnapshot } from "@/types";

export function WaitingPhase() {
  const snapshot = useGameStore((s) => s.snapshot)!;
  const privateState = useGameStore((s) => s.privateState);
  const sendCommand = useGameStore((s) => s.sendCommand);
  const addToast = useGameStore((s) => s.addToast);
  const me = snapshot.players.find((p) => p.id === privateState?.playerId);
  const isHost = me?.isHost ?? false;

  const activePlayers = snapshot.players.filter((p) => p.membership === "active");
  const nonHostActive = activePlayers.filter((p) => !p.isHost);
  const canSoloStart = snapshot.testMode && isHost && nonHostActive.length === 0;
  const allReady = canSoloStart || (nonHostActive.length > 0 && nonHostActive.every((p) => p.isReady));
  const readyCount = nonHostActive.filter((p) => p.isReady).length;
  const showProgress = nonHostActive.length > 0;

  useEffect(() => {
    if (isHost && me && !me.isReady) {
      sendCommand("player.setReady", { ready: true }).catch(() => {});
    }
  }, [isHost, me, sendCommand]);

  const handleReady = useCallback(async () => {
    try {
      await sendCommand("player.setReady", { ready: !me?.isReady });
    } catch (e) {
      addToast((e as { message: string }).message, "error");
    }
  }, [me, sendCommand, addToast]);

  const handleStart = useCallback(async () => {
    try {
      await sendCommand("game.advancePhase");
    } catch (e) {
      addToast((e as { message: string }).message, "error");
    }
  }, [sendCommand, addToast]);

  if (isHost) {
    return (
      <HostWaitingPanel
        snapshot={snapshot}
        showProgress={showProgress}
        readyCount={readyCount}
        nonHostTotal={nonHostActive.length}
        canSoloStart={canSoloStart}
        allReady={allReady}
        onStart={handleStart}
        sendCommand={sendCommand}
        addToast={addToast}
      />
    );
  }

  // 非房主视角：只读预览设置，准备按钮
  return (
    <div className="mx-auto flex max-w-md flex-col items-center gap-6">
      <PhaseHeader icon={Gamepad2} title="等待开始" />
      <SettingsPreview snapshot={snapshot} />
      {showProgress && (
        <div className="w-full space-y-2 text-center">
          <p className="text-sm text-muted-foreground">
            {readyCount}/{nonHostActive.length} 名玩家已准备
          </p>
          <div className="mx-auto h-1.5 w-48 overflow-hidden rounded-full bg-muted">
            <motion.div
              className="h-full rounded-full bg-primary"
              initial={false}
              animate={{ width: `${(readyCount / nonHostActive.length) * 100}%` }}
              transition={spring.settle}
            />
          </div>
        </div>
      )}
      {me?.membership === "active" && (
        <Button
          variant={me.isReady ? "outline" : "default"}
          size="lg"
          onClick={handleReady}
          className="gap-2 min-w-[120px]"
        >
          {me.isReady ? <><X className="h-4 w-4" />取消准备</> : <><Check className="h-4 w-4" />准备</>}
        </Button>
      )}
    </div>
  );
}

/* ── 房主视角 ────────────────────────────────────────────── */

interface HostWaitingPanelProps {
  snapshot: RoomSnapshot;
  showProgress: boolean;
  readyCount: number;
  nonHostTotal: number;
  canSoloStart: boolean;
  allReady: boolean;
  onStart: () => void;
  sendCommand: (type: string, payload?: Record<string, unknown>) => Promise<Record<string, unknown>>;
  addToast: (text: string, type?: "info" | "error" | "success") => void;
}

function HostWaitingPanel({
  snapshot, showProgress, readyCount, nonHostTotal,
  canSoloStart, allReady, onStart,
  sendCommand, addToast,
}: HostWaitingPanelProps) {
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [copied, setCopied] = useState(false);

  const shareUrl = `${window.location.origin}/whoisfaker/room/${snapshot.roomId}`;

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(shareUrl);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      addToast("复制失败，请手动复制", "error");
    }
  };

  return (
    <div className="mx-auto w-full max-w-md space-y-5">
      <PhaseHeader icon={Gamepad2} title="等待玩家加入" />

      {/* 房间链接分享 */}
      <div className="space-y-2">
        <Label className="text-xs text-muted-foreground">房间链接</Label>
        <div className="flex gap-2">
          <div className="flex min-w-0 flex-1 items-center gap-2 rounded-md border bg-muted/30 px-3 py-2">
            <Link className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
            <span className="min-w-0 flex-1 truncate font-mono text-xs text-muted-foreground">
              {shareUrl}
            </span>
          </div>
          <motion.button
            type="button"
            {...pressable}
            onClick={handleCopy}
            className={cn(
              "flex h-9 items-center gap-1.5 rounded-md border px-3 text-xs font-medium transition-colors",
              copied
                ? "border-emerald-500/40 bg-emerald-500/10 text-emerald-700"
                : "hover:bg-accent/60",
            )}
          >
            <Copy className="h-3.5 w-3.5" />
            {copied ? "已复制" : "复制"}
          </motion.button>
        </div>
      </div>

      {/* 进度条：有其他玩家时显示 */}
      {showProgress && (
        <div className="space-y-2">
          <div className="flex items-center justify-between text-xs text-muted-foreground">
            <span>玩家准备进度</span>
            <span>{readyCount}/{nonHostTotal}</span>
          </div>
          <div className="h-1.5 overflow-hidden rounded-full bg-muted">
            <motion.div
              className="h-full rounded-full bg-primary"
              initial={false}
              animate={{ width: `${(readyCount / nonHostTotal) * 100}%` }}
              transition={spring.settle}
            />
          </div>
        </div>
      )}

      {/* 房间设置（折叠） */}
      <div className="rounded-md border">
        <motion.button
          type="button"
          {...pressable}
          onClick={() => setSettingsOpen((v) => !v)}
          aria-expanded={settingsOpen}
          className="flex w-full items-center gap-2 px-4 py-3 text-sm font-medium transition-colors hover:bg-accent/40"
        >
          <Settings className="h-4 w-4 text-muted-foreground" />
          <span className="flex-1 text-left">房间设置</span>
          <motion.span
            className="inline-flex text-muted-foreground"
            animate={{ rotate: settingsOpen ? 180 : 0 }}
            transition={spring.snap}
          >
            <ChevronDown className="h-4 w-4" />
          </motion.span>
        </motion.button>
        <AnimatePresence initial={false}>
          {settingsOpen && (
            <motion.div
              variants={collapsible}
              initial="initial"
              animate="animate"
              exit="exit"
              className="overflow-hidden"
            >
              <div className="border-t px-4 py-4">
                <InlineSettings
                  snapshot={snapshot}
                  sendCommand={sendCommand}
                  addToast={addToast}
                />
              </div>
            </motion.div>
          )}
        </AnimatePresence>
      </div>

      {/* 开始按钮 */}
      <Button
        size="lg"
        disabled={!allReady}
        onClick={onStart}
        className="w-full text-base"
      >
        {canSoloStart ? "开始游戏" : allReady ? "开始游戏" : `等待玩家准备 (${readyCount}/${nonHostTotal})`}
      </Button>
    </div>
  );
}

/* ── 行内设置表单（房主） ────────────────────────────────── */

interface InlineSettingsProps {
  snapshot: RoomSnapshot;
  sendCommand: (type: string, payload?: Record<string, unknown>) => Promise<Record<string, unknown>>;
  addToast: (text: string, type?: "info" | "error" | "success") => void;
}

function InlineSettings({ snapshot, sendCommand, addToast }: InlineSettingsProps) {
  const [name, setName] = useState(snapshot.name);
  const [isPrivate, setIsPrivate] = useState(snapshot.visibility === "private");
  const [password, setPassword] = useState("");
  const [allowSpectators, setAllowSpectators] = useState(snapshot.allowSpectators);
  const [undercoverCount, setUndercoverCount] = useState(snapshot.settings.roleConfig.undercoverCount);
  const limits = snapshot.roleLimits;

  const handleSave = async () => {
    try {
      await sendCommand("room.updateSettings", {
        name: name || undefined,
        visibility: isPrivate ? "private" : "public",
        password: isPrivate ? password || undefined : "",
        allowSpectators,
        roleConfig: {
          undercoverCount: Math.max(1, Math.min(undercoverCount, limits.maxUndercoverCount)),
          hasAngel: limits.canEnableAngel && snapshot.settings.roleConfig.hasAngel,
          hasBlank: limits.canEnableBlank && snapshot.settings.roleConfig.hasBlank,
        },
      });
      addToast("设置已保存", "success");
    } catch (e) {
      addToast((e as { message: string }).message, "error");
    }
  };

  return (
    <div className="space-y-4">
      <div className="space-y-1.5">
        <Label className="text-xs">房间名称</Label>
        <Input value={name} onChange={(e) => setName(e.target.value)} className="h-9" />
      </div>
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          {isPrivate ? <Lock className="h-3.5 w-3.5 text-muted-foreground" /> : <Globe className="h-3.5 w-3.5 text-muted-foreground" />}
          <Label className="text-xs">私密房间</Label>
        </div>
        <Switch checked={isPrivate} onCheckedChange={setIsPrivate} />
      </div>
      <AnimatePresence initial={false}>
        {isPrivate && (
          <motion.div variants={collapsible} initial="initial" animate="animate" exit="exit" className="overflow-hidden">
            <div className="space-y-1.5 pt-1">
              <Label className="text-xs">密码</Label>
              <Input type="password" value={password} onChange={(e) => setPassword(e.target.value)} placeholder="留空则保留当前密码" className="h-9" />
            </div>
          </motion.div>
        )}
      </AnimatePresence>
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <Users className="h-3.5 w-3.5 text-muted-foreground" />
          <Label className="text-xs">允许旁观</Label>
        </div>
        <Switch checked={allowSpectators} onCheckedChange={setAllowSpectators} />
      </div>
      <div className="flex items-center justify-between">
        <Label className="text-xs">卧底人数</Label>
        <div className="flex items-center gap-2">
          <Button variant="outline" size="icon" className="h-7 w-7"
            onClick={() => setUndercoverCount((c) => Math.max(1, c - 1))}
            disabled={undercoverCount <= 1}
          ><Minus className="h-3 w-3" /></Button>
          <span className="w-5 text-center text-sm font-medium tabular-nums">{undercoverCount}</span>
          <Button variant="outline" size="icon" className="h-7 w-7"
            onClick={() => setUndercoverCount((c) => Math.min(limits.maxUndercoverCount, c + 1))}
            disabled={undercoverCount >= limits.maxUndercoverCount}
          ><Plus className="h-3 w-3" /></Button>
          <span className="text-xs text-muted-foreground">上限 {limits.maxUndercoverCount}</span>
        </div>
      </div>
      <Button size="sm" onClick={handleSave} className="w-full">保存设置</Button>
    </div>
  );
}

/* ── 只读设置预览（非房主） ─────────────────────────────── */

function SettingsPreview({ snapshot }: { snapshot: RoomSnapshot }) {
  const cfg = snapshot.settings.roleConfig;
  const items = [
    snapshot.visibility === "private" ? "私密房间" : "公开房间",
    snapshot.allowSpectators ? "允许旁观" : "不允许旁观",
    `${cfg.undercoverCount} 名卧底`,
    ...(cfg.hasAngel ? ["含天使"] : []),
    ...(cfg.hasBlank ? ["含白板"] : []),
  ];
  return (
    <div className="flex flex-wrap justify-center gap-2">
      {items.map((item) => (
        <span key={item} className="rounded-md bg-muted px-2.5 py-1 text-xs text-muted-foreground">
          {item}
        </span>
      ))}
    </div>
  );
}
