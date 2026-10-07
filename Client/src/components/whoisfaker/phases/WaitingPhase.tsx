import { useCallback, useState } from "react";
import { Check, X, Gamepad2, Settings, Lock, Globe, Users, Eye, VenetianMask } from "lucide-react";
import { Button } from "@/components/ui/Button";
import { CollapsibleRegion } from "@/components/ui/Collapsible";
import { PhaseHeader } from "@/components/common/PhaseHeader";
import { ReadyProgress } from "@/components/common/room/ReadyProgress";
import { RoomLinkShare } from "@/components/common/room/RoomLinkShare";
import { SettingStepper, SettingSwitchRow, SettingTextField } from "@/components/common/room/SettingFields";
import { SettingsAccordion, SettingsStack } from "@/components/common/room/SettingsAccordion";
import { useWhoIsFakerStore } from "@/stores/UseWhoIsFakerStore";
import { useAutoSave } from "@/hooks/UseAutoSave";
import type { RoleConfig, RoleLimits, WhoIsFakerRoomSnapshot } from "@/types";

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


  // 非房主视角：与房主同一份设置结构，只读；底部是准备按钮。
  return (
    <div className="mx-auto w-full max-w-md space-y-5">
      <PhaseHeader icon={Gamepad2} title="等待开始" />
      <RoomLinkShare path={`/whoisfaker/room/${snapshot.roomId}`} onCopyError={notifyCopyFailed} />
      {showProgress && <ReadyProgress ready={readyCount} total={nonHostActive.length} variant="guest" />}
      <FakerSettings snapshot={snapshot} readOnly sendCommand={sendCommand} addToast={addToast} />
      {me?.membership === "active" && (
        <div className="flex justify-center">
          <Button
            variant={me.isReady ? "outline" : "default"}
            size="lg"
            disabled={readying}
            loading={readying}
            onClick={handleReady}
          >
            {/* 进行中只把图标换成转圈，文案不变，按钮宽度不跳 */}
            {me.isReady ? <>{readying ? null : <X className="h-4 w-4" />}取消准备</> : <>{readying ? null : <Check className="h-4 w-4" />}准备</>}
          </Button>
        </div>
      )}
    </div>
  );
}

/* ── 房主视角 ────────────────────────────────────────────── */

interface HostWaitingPanelProps {
  snapshot: WhoIsFakerRoomSnapshot;
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
  return (
    <div className="mx-auto w-full max-w-md space-y-5">
      <PhaseHeader icon={Gamepad2} title="等待玩家加入" />

      <RoomLinkShare path={`/whoisfaker/room/${snapshot.roomId}`} onCopyError={notifyCopyFailed} />

      {/* 进度条：有其他玩家时显示 */}
      {showProgress && <ReadyProgress ready={readyCount} total={nonHostTotal} variant="host" />}

      <FakerSettings
        key={snapshot.status.roundId || snapshot.roomId}
        snapshot={snapshot}
        readOnly={false}
        sendCommand={sendCommand}
        addToast={addToast}
      />

      {/* 开始按钮 */}
      <Button
        size="lg"
        disabled={!allReady || starting}
        loading={starting}
        onClick={onStart}
        className="w-full text-base"
      >
        {allReady
            ? "开始游戏"
            : nonHostTotal === 0
              ? "等待玩家加入"
              : `等待玩家准备 (${readyCount}/${nonHostTotal})`}
      </Button>
    </div>
  );
}

/* ── 阵营配置 ────────────────────────────────────────────── */

/** 按当前人数上限夹住阵营配置，与服务端 clampRoleConfig 同口径：保存、步进器、开关与只读视图都读这一份。 */
function effectiveRoleConfig(config: RoleConfig, limits: RoleLimits): RoleConfig {
  return {
    undercoverCount: Math.max(1, Math.min(config.undercoverCount, limits.maxUndercoverCount)),
    hasAngel: limits.canEnableAngel && config.hasAngel,
    hasBlank: limits.canEnableBlank && config.hasBlank,
  };
}

/* ── 设置（房主可改，其他人只读） ───────────────────────── */

interface FakerSettingsProps {
  snapshot: WhoIsFakerRoomSnapshot;
  readOnly: boolean;
  sendCommand: (type: string, payload?: Record<string, unknown>) => Promise<Record<string, unknown>>;
  addToast: (text: string, type?: "info" | "error" | "success") => void;
}

/** 当前快照里的设置：非房主直接读它，房主的草稿也从它起步。 */
const settingsOf = (snapshot: WhoIsFakerRoomSnapshot) => ({
  name: snapshot.name,
  isPrivate: snapshot.visibility === "private",
  password: "",
  allowSpectators: snapshot.allowSpectators,
  revealRoleOnDeath: snapshot.settings.revealRoleOnDeath ?? true,
  ...snapshot.settings.roleConfig,
});

/**
 * 两组折叠设置：「身份设置」管阵营与揭露规则，「房间设置」管房间本身；两组共用一份草稿、一条防抖自动保存。
 * 非房主看到同一份结构，字段只显示取值，读的是当前快照而不是草稿。
 */
function FakerSettings({ snapshot, readOnly, sendCommand, addToast }: FakerSettingsProps) {
  const limits = snapshot.roleLimits;
  const [draft, setDraft] = useState(() => settingsOf(snapshot));
  const [rolesOpen, setRolesOpen] = useState(false);
  const [roomOpen, setRoomOpen] = useState(false);
  const values = readOnly ? settingsOf(snapshot) : draft;
  const edit = <K extends keyof typeof draft>(key: K, value: (typeof draft)[K]) =>
    setDraft((current) => ({ ...current, [key]: value }));
  // 控件显示夹过的值，与实际保存的一致；本地仍记着房主的原意，人数回升后自动恢复。
  const roleConfig = effectiveRoleConfig(values, limits);

  useAutoSave({
    name: draft.name || undefined,
    visibility: draft.isPrivate ? "private" : "public",
    password: draft.isPrivate ? draft.password || undefined : "",
    allowSpectators: draft.allowSpectators,
    revealRoleOnDeath: draft.revealRoleOnDeath,
    roleConfig: effectiveRoleConfig(draft, limits),
  }, (payload) => sendCommand("room.updateSettings", payload), {
    enabled:
      !readOnly &&
      snapshot.status.phase === "waiting" &&
      (!draft.isPrivate || snapshot.hasPassword || draft.password.trim().length > 0),
    onError: (error) => addToast((error as { message: string }).message, "error"),
  });

  return (
    <SettingsStack>
      <SettingsAccordion
        icon={VenetianMask}
        title="身份设置"
        open={rolesOpen}
        onOpenChange={setRolesOpen}
        readOnly={readOnly}
        summary={[
          `${roleConfig.undercoverCount} 名卧底`,
          roleConfig.hasAngel ? "天使" : "",
          roleConfig.hasBlank ? "白板" : "",
          values.revealRoleOnDeath ? "死亡揭露身份" : "死亡隐藏身份",
        ]}
      >
        <div className="space-y-4">
          <SettingStepper label="卧底人数" description={`上限 ${limits.maxUndercoverCount}`} value={roleConfig.undercoverCount}
            minimum={1} maximum={limits.maxUndercoverCount} format={(value) => `${value} 名`} onChange={(value) => edit("undercoverCount", value)} />
          <SettingSwitchRow label="天使" description={limits.canEnableAngel ? "持有双词，首夜选阵营，有一次护盾。" : "8 人开启"}
            checked={roleConfig.hasAngel} disabled={!limits.canEnableAngel} onCheckedChange={(value) => edit("hasAngel", value)} />
          <SettingSwitchRow label="白板" description={limits.canEnableBlank ? "没有词语，只知道词性。" : "8 人开启"}
            checked={roleConfig.hasBlank} disabled={!limits.canEnableBlank} onCheckedChange={(value) => edit("hasBlank", value)} />
          <SettingSwitchRow label="死亡时揭露身份" icon={Eye} checked={values.revealRoleOnDeath} onCheckedChange={(value) => edit("revealRoleOnDeath", value)} />
        </div>
      </SettingsAccordion>

      <SettingsAccordion
        icon={Settings}
        title="房间设置"
        open={roomOpen}
        onOpenChange={setRoomOpen}
        readOnly={readOnly}
        summary={[values.isPrivate ? "私密房间" : "公开房间", values.allowSpectators ? "允许旁观" : "不允许旁观"]}
      >
        <div className="space-y-4">
          <SettingTextField label="房间名称" value={values.name} maxLength={40} placeholder="输入房间名称" onChange={(value) => edit("name", value)} />
          <SettingSwitchRow label="私密房间" icon={values.isPrivate ? Lock : Globe} checked={values.isPrivate} onCheckedChange={(value) => edit("isPrivate", value)} />
          {!readOnly ? (
            <CollapsibleRegion open={values.isPrivate}>
              {/* 还没有密码时留空不会保存（私密房间必须有密码），占位文案按是否已有密码区分。 */}
              <SettingTextField label="房间密码" type="password" value={draft.password} onChange={(value) => edit("password", value)}
                placeholder={snapshot.hasPassword ? "留空则保留当前密码" : "设置房间密码"} />
            </CollapsibleRegion>
          ) : null}
          <SettingSwitchRow label="允许旁观" icon={Users} checked={values.allowSpectators} onCheckedChange={(value) => edit("allowSpectators", value)} />
        </div>
      </SettingsAccordion>
    </SettingsStack>
  );
}
