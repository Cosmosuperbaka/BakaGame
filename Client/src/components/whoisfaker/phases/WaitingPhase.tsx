import { useCallback, useEffect, useState } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { Check, X, Gamepad2, Settings, Lock, Globe, Users, Eye } from "lucide-react";
import { Button } from "@/components/ui/Button";
import { collapsible } from "@/lib/Motion";
import { PhaseHeader } from "@/components/common/PhaseHeader";
import { ReadyProgress } from "@/components/common/room/ReadyProgress";
import { RoomLinkShare } from "@/components/common/room/RoomLinkShare";
import { SettingStepper, SettingSwitchRow, SettingTextField } from "@/components/common/room/SettingFields";
import { SettingsAccordion, SettingsChips } from "@/components/common/room/SettingsAccordion";
import { useWhoIsFakerStore } from "@/stores/UseWhoIsFakerStore";
import { useAutoSave } from "@/hooks/UseAutoSave";
import type { RoleConfig, RoleLimits, RoomSnapshot } from "@/types";

const notifyCopyFailed = () => useWhoIsFakerStore.getState().addToast("复制失败，请手动复制", "error");

export function WaitingPhase() {
  const snapshot = useWhoIsFakerStore((s) => s.snapshot)!;
  const privateState = useWhoIsFakerStore((s) => s.privateState);
  const sendCommand = useWhoIsFakerStore((s) => s.sendCommand);
  const addToast = useWhoIsFakerStore((s) => s.addToast);
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

  // 与猜歌同口径：准备、开始在等服务端应答期间显示加载态并禁用，避免连点发出相反的两条命令。
  const [readying, setReadying] = useState(false);
  const handleReady = useCallback(async () => {
    if (readying) return;
    setReadying(true);
    try {
      await sendCommand("player.setReady", { ready: !me?.isReady });
    } catch (e) {
      addToast((e as { message: string }).message, "error");
    } finally {
      setReadying(false);
    }
  }, [me, sendCommand, addToast, readying]);

  const [starting, setStarting] = useState(false);
  const handleStart = useCallback(async () => {
    if (starting) return;
    setStarting(true);
    try {
      await sendCommand("game.advancePhase");
    } catch (e) {
      addToast((e as { message: string }).message, "error");
    } finally {
      setStarting(false);
    }
  }, [sendCommand, addToast, starting]);

  if (isHost) {
    return (
      <HostWaitingPanel
        snapshot={snapshot}
        showProgress={showProgress}
        readyCount={readyCount}
        nonHostTotal={nonHostActive.length}
        allReady={allReady}
        starting={starting}
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
      <RoomLinkShare path={`/whoisfaker/room/${snapshot.roomId}`} onCopyError={notifyCopyFailed} />
      <SettingsPreview snapshot={snapshot} />
      {showProgress && <ReadyProgress ready={readyCount} total={nonHostActive.length} variant="guest" />}
      {me?.membership === "active" && (
        <Button
          variant={me.isReady ? "outline" : "default"}
          size="lg"
          disabled={readying}
          loading={readying}
          onClick={handleReady}
          className="gap-2 min-w-[120px]"
        >
          {readying
            ? me.isReady ? "正在取消..." : "正在准备..."
            : me.isReady ? <><X className="h-4 w-4" />取消准备</> : <><Check className="h-4 w-4" />准备</>}
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
  allReady: boolean;
  starting?: boolean;
  onStart: () => void;
  sendCommand: (type: string, payload?: Record<string, unknown>) => Promise<Record<string, unknown>>;
  addToast: (text: string, type?: "info" | "error" | "success") => void;
}

function HostWaitingPanel({
  snapshot, showProgress, readyCount, nonHostTotal,
  allReady, starting, onStart,
  sendCommand, addToast,
}: HostWaitingPanelProps) {
  const [settingsOpen, setSettingsOpen] = useState(false);

  return (
    <div className="mx-auto w-full max-w-md space-y-5">
      <PhaseHeader icon={Gamepad2} title="等待玩家加入" />

      <RoomLinkShare path={`/whoisfaker/room/${snapshot.roomId}`} onCopyError={notifyCopyFailed} />

      {/* 进度条：有其他玩家时显示 */}
      {showProgress && <ReadyProgress ready={readyCount} total={nonHostTotal} variant="host" />}

      <SettingsAccordion icon={Settings} title="房间设置" open={settingsOpen} onOpenChange={setSettingsOpen}>
        <InlineSettings
          key={snapshot.status.roundId || snapshot.roomId}
          snapshot={snapshot}
          sendCommand={sendCommand}
          addToast={addToast}
        />
      </SettingsAccordion>

      {/* 开始按钮 */}
      <Button
        size="lg"
        disabled={!allReady || starting}
        loading={starting}
        onClick={onStart}
        className="w-full text-base"
      >
        {starting
          ? "正在开始游戏..."
          : allReady
            ? "开始游戏"
            : nonHostTotal === 0
              ? "等待玩家加入"
              : `等待玩家准备 (${readyCount}/${nonHostTotal})`}
      </Button>
    </div>
  );
}

/* ── 阵营配置 ────────────────────────────────────────────── */

/** 按当前人数上限夹住阵营配置，与服务端 clampRoleConfig 同口径：保存、步进器、开关与只读预览都读这一份。 */
function effectiveRoleConfig(config: RoleConfig, limits: RoleLimits): RoleConfig {
  return {
    undercoverCount: Math.max(1, Math.min(config.undercoverCount, limits.maxUndercoverCount)),
    hasAngel: limits.canEnableAngel && config.hasAngel,
    hasBlank: limits.canEnableBlank && config.hasBlank,
  };
}

/* ── 行内设置表单（房主） ────────────────────────────────── */

interface InlineSettingsProps {
  snapshot: RoomSnapshot;
  sendCommand: (type: string, payload?: Record<string, unknown>) => Promise<Record<string, unknown>>;
  addToast: (text: string, type?: "info" | "error" | "success") => void;
}

function InlineSettings({ snapshot, sendCommand, addToast }: InlineSettingsProps) {
  const limits = snapshot.roleLimits;

  const [name, setName] = useState(snapshot.name);
  const [isPrivate, setIsPrivate] = useState(snapshot.visibility === "private");
  const [password, setPassword] = useState("");
  const [allowSpectators, setAllowSpectators] = useState(snapshot.allowSpectators);
  const [revealRoleOnDeath, setRevealRoleOnDeath] = useState(snapshot.settings.revealRoleOnDeath ?? true);
  const [undercoverCount, setUndercoverCount] = useState(snapshot.settings.roleConfig.undercoverCount);
  const [hasAngel, setHasAngel] = useState(snapshot.settings.roleConfig.hasAngel);
  const [hasBlank, setHasBlank] = useState(snapshot.settings.roleConfig.hasBlank);
  // 控件显示夹过的值，与实际保存的一致；本地仍记着房主的原意，人数回升后自动恢复。
  const roleConfig = effectiveRoleConfig({ undercoverCount, hasAngel, hasBlank }, limits);

  const draft = {
    name: name || undefined,
    visibility: isPrivate ? "private" : "public",
    password: isPrivate ? password || undefined : "",
    allowSpectators,
    revealRoleOnDeath,
    roleConfig,
  };
  useAutoSave(draft, (payload) => sendCommand("room.updateSettings", payload), {
    enabled:
      snapshot.status.phase === "waiting" &&
      (!isPrivate || snapshot.hasPassword || password.trim().length > 0),
    onError: (error) => addToast((error as { message: string }).message, "error"),
  });

  return (
    <div className="space-y-4">
      <SettingTextField label="房间名称" value={name} maxLength={40} placeholder="输入房间名称" onChange={setName} />
      <SettingSwitchRow label="私密房间" icon={isPrivate ? Lock : Globe} checked={isPrivate} onCheckedChange={setIsPrivate} />
      <AnimatePresence initial={false}>
        {isPrivate && (
          <motion.div variants={collapsible} initial="initial" animate="animate" exit="exit" className="overflow-hidden">
            <div className="pt-1">
              {/* 还没有密码时留空不会保存（私密房间必须有密码），占位文案按是否已有密码区分。 */}
              <SettingTextField label="房间密码" type="password" value={password} onChange={setPassword}
                placeholder={snapshot.hasPassword ? "留空则保留当前密码" : "设置房间密码"} />
            </div>
          </motion.div>
        )}
      </AnimatePresence>
      <SettingSwitchRow label="允许旁观" icon={Users} checked={allowSpectators} onCheckedChange={setAllowSpectators} />
      <SettingSwitchRow label="死亡时揭露身份" icon={Eye} checked={revealRoleOnDeath} onCheckedChange={setRevealRoleOnDeath} />
      <SettingStepper label="卧底人数" description={`上限 ${limits.maxUndercoverCount}`} value={roleConfig.undercoverCount}
        minimum={1} maximum={limits.maxUndercoverCount} onChange={setUndercoverCount} />
      <SettingSwitchRow label="天使" description={limits.canEnableAngel ? undefined : "8 人开启"} checked={roleConfig.hasAngel}
        disabled={!limits.canEnableAngel} onCheckedChange={setHasAngel} />
      <SettingSwitchRow label="白板" description={limits.canEnableBlank ? undefined : "8 人开启"} checked={roleConfig.hasBlank}
        disabled={!limits.canEnableBlank} onCheckedChange={setHasBlank} />
    </div>
  );
}

/* ── 只读设置预览（非房主） ─────────────────────────────── */

function SettingsPreview({ snapshot }: { snapshot: RoomSnapshot }) {
  const roleConfig = effectiveRoleConfig(snapshot.settings.roleConfig, snapshot.roleLimits);

  const items = [
    snapshot.visibility === "private" ? "私密房间" : "公开房间",
    snapshot.allowSpectators ? "允许旁观" : "不允许旁观",
    (snapshot.settings.revealRoleOnDeath ?? true) ? "死亡揭露身份" : "死亡隐藏身份",
    `${roleConfig.undercoverCount} 名卧底`,
    ...(roleConfig.hasAngel ? ["1 名天使"] : []),
    ...(roleConfig.hasBlank ? ["1 名白板"] : []),
  ];
  return <SettingsChips items={items} />;
}
