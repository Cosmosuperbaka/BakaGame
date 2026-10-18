/* eslint-disable react-refresh/only-export-components -- 恢复函数与等待页共享同一份目录同步规则，放一起改动时不会漏掉一边。 */
import { useState } from "react";
import { Check, EyeOff, Gamepad2, Globe, Lock, Settings, Users, X } from "lucide-react";
import type { CEEPrivateState, CEERoomSnapshot } from "@bakagame/shared";
import { Button } from "@/components/ui/Button";
import { PhaseHeader } from "@/components/common/PhaseHeader";
import { ReadyProgress } from "@/components/common/room/ReadyProgress";
import { RoomLinkShare } from "@/components/common/room/RoomLinkShare";
import { RoomRestoreFallback } from "@/components/common/room/RoomRestoreFallback";
import { SettingsAccordion, SettingsStack } from "@/components/common/room/SettingsAccordion";
import {
  SettingReveal,
  SettingSwitchRow,
  SettingTextField,
  SettingsFields,
} from "@/components/common/room/SettingFields";
import { useAutoSave } from "@/hooks/UseAutoSave";
import { useCEEAction } from "@/hooks/UseCEEAction";
import { useRoomSettingsRestore } from "@/hooks/UseRoomSettingsRestore";
import { ceeErrorMessage, useCEEStore } from "@/stores/UseCEEStore";
import { ceeRoomPath } from "@/lib/CEESession";
import type { CEERoomSettingsMemory } from "@/lib/RoomSettingsMemory";
import { CEEGameSettings } from "./CEEGameSettings";
import { CEETeamPicker } from "./CEETeamPicker";

/**
 * 套用上局的玩法设置：用了 Bangumi 目录时先同步入库（服务端只从已落库的成员出题），
 * 目录同步失败即整体放弃——宁可用服务端默认值，也不要一份抽不出题的设置。
 */
export async function restoreCEESettings(memory: CEERoomSettingsMemory): Promise<void> {
  const { settings } = memory;
  if (settings.useIndex && settings.indexId !== null) {
    await useCEEStore.getState().sendCommand("cee.directory.import", { indexId: settings.indexId });
  }
  await useCEEStore.getState().sendCommand("cee.room.settings", { settings });
}

/** 房主的房间设置草稿：名称、是否公开、是否允许旁观与私密密码。 */
type RoomDraft = {
  name: string;
  visibility: CEERoomSnapshot["visibility"];
  allowSpectators: boolean;
  password: string;
};

/** 私密房间必须有密码——这是增强房的语义，原版房没有密码机制，那里的「不公开」只表示不进大厅。 */
const roomValidationText = (
  source: CEERoomSnapshot["source"],
  draft: RoomDraft,
  hasPassword: boolean
): string =>
  source === "native" && draft.visibility === "private" && !draft.password.trim() && !hasPassword
    ? "私密房间需要密码，填写后才会保存"
    : "";

/** 折叠面板收起时显示的两行摘要，与面板里的开关口径一致。 */
const roomSummaryLines = (snapshot: CEERoomSnapshot): string[] => [
  snapshot.visibility === "private"
    ? snapshot.source === "original"
      ? "不在大厅显示"
      : "私密房间"
    : "公开房间",
  snapshot.allowSpectators ? "允许旁观" : "不允许旁观",
];

/** 与建房弹窗同一措辞：增强房的私密房设密码，原版房没有密码机制，开关只控制是否进大厅。 */
const visibilityIcon = (
  source: CEERoomSnapshot["source"],
  visibility: CEERoomSnapshot["visibility"]
) => (visibility !== "private" ? Globe : source === "original" ? EyeOff : Lock);

/** 房主开始按钮的文案：既说明能不能开始，也说明卡在哪儿。 */
const startButtonLabel = (state: {
  canStart: boolean;
  manual: boolean;
  otherCount: number;
  readyCount: number;
}): string => {
  if (state.canStart) return state.manual ? "开始并指定出题人" : "开始游戏";
  if (state.otherCount === 0) return "等待玩家加入";
  if (state.manual) return "暂无可选出题人";
  return `等待玩家准备 (${state.readyCount}/${state.otherCount})`;
};

type RoomSettingsSectionProps = {
  snapshot: CEERoomSnapshot;
  isHost: boolean;
  draft: RoomDraft;
  validation: string;
  notice: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onEdit: <K extends keyof RoomDraft>(key: K, value: RoomDraft[K]) => void;
};

/**
 * 房间设置面板：房主改的是草稿（防抖自动保存），其他玩家看到同一份结构但只读。
 * 房间设置的改动与题目设置分开保存，互不覆盖。
 */
function RoomSettingsSection({
  snapshot,
  isHost,
  draft,
  validation,
  notice,
  open,
  onOpenChange,
  onEdit,
}: RoomSettingsSectionProps) {
  // 非房主读当前快照；房主读草稿。
  const roomValues = isHost
    ? draft
    : { visibility: snapshot.visibility, allowSpectators: snapshot.allowSpectators };

  return (
    <SettingsAccordion
      icon={Settings}
      title="房间设置"
      open={open}
      onOpenChange={onOpenChange}
      readOnly={!isHost}
      summary={roomSummaryLines(snapshot)}
    >
      <SettingsFields>
        <SettingTextField
          label="房间名称"
          value={isHost ? draft.name : snapshot.name}
          maxLength={snapshot.source === "original" ? 30 : 32}
          placeholder="输入房间名称"
          onChange={(value) => onEdit("name", value)}
        />
        <SettingSwitchRow
          label={snapshot.source === "original" ? "不在大厅显示" : "私密房间"}
          description={
            snapshot.source === "original" ? "开启后不在大厅列出，凭链接仍可进入。" : undefined
          }
          icon={visibilityIcon(snapshot.source, roomValues.visibility)}
          checked={roomValues.visibility === "private"}
          onCheckedChange={(checked) => onEdit("visibility", checked ? "private" : "public")}
        />
        {isHost && snapshot.source === "native" ? (
          <SettingReveal open={draft.visibility === "private"}>
            <SettingTextField
              label="房间密码"
              type="password"
              value={draft.password}
              placeholder={snapshot.hasPassword ? "留空则保留当前密码" : "设置房间密码"}
              onChange={(value) => onEdit("password", value)}
            />
          </SettingReveal>
        ) : null}
        {snapshot.source === "native" ? (
          <SettingSwitchRow
            label="允许旁观"
            icon={Users}
            checked={roomValues.allowSpectators}
            onCheckedChange={(checked) => onEdit("allowSpectators", checked)}
          />
        ) : null}
        {validation ? (
          <p role="alert" className="text-xs text-destructive">
            {validation}
          </p>
        ) : null}
        {notice ? (
          <p role="alert" className="text-xs text-destructive">
            {notice}
          </p>
        ) : null}
      </SettingsFields>
    </SettingsAccordion>
  );
}

type WaitingActionsProps = {
  isHost: boolean;
  me?: CEERoomSnapshot["players"][number];
  canStart: boolean;
  manual: boolean;
  starting: boolean;
  readying: boolean;
  readyCount: number;
  otherCount: number;
  onStart: () => void;
  onToggleReady: (ready: boolean) => void;
};

/** 底部动作区：房主只有开始按钮（没有准备态），其他正式玩家只有准备按钮。 */
function WaitingActions({
  isHost,
  me,
  canStart,
  manual,
  starting,
  readying,
  readyCount,
  otherCount,
  onStart,
  onToggleReady,
}: WaitingActionsProps) {
  if (isHost) {
    return (
      <Button
        size="lg"
        className="w-full text-base"
        disabled={starting || !canStart}
        loading={starting}
        onClick={onStart}
      >
        {startButtonLabel({ canStart, manual, otherCount, readyCount })}
      </Button>
    );
  }

  const activeMe = me?.membership === "active" ? me : undefined;
  if (!activeMe) return null;

  return (
    <div className="flex justify-center">
      <Button
        variant={activeMe.ready ? "outline" : "default"}
        size="lg"
        className="min-w-[120px] gap-2"
        disabled={readying}
        loading={readying}
        onClick={() => onToggleReady(activeMe.ready)}
      >
        {activeMe.ready ? (
          <>{readying ? null : <X className="h-4 w-4" />}取消准备</>
        ) : (
          <>{readying ? null : <Check className="h-4 w-4" />}准备</>
        )}
      </Button>
    </div>
  );
}

/**
 * CEE 等待页，与另外两个游戏同一结构：房主在折叠面板里直接改设置（防抖自动保存），底部只有开始按钮，
 * 房主没有准备态；其他玩家看到同一份设置结构（只读）与准备按钮。房间设置的改动与题目设置分开保存，互不覆盖。
 * 出题方式在设置里：随机出题要等其他人都准备；指定出题人点开始后进入选人阶段，出题人不必准备。
 */
export function CEEWaiting({
  snapshot,
  privateState,
}: {
  snapshot: CEERoomSnapshot;
  privateState: CEEPrivateState;
}) {
  const isHost = snapshot.hostPlayerId === privateState.playerId;
  const me = snapshot.players.find((player) => player.id === privateState.playerId);
  // 准备进度只算房主以外的参与者，与另外两个游戏同口径。
  const others = snapshot.players.filter(
    (player) => player.membership === "active" && player.id !== snapshot.hostPlayerId
  );
  const readyCount = others.filter((player) => player.ready).length;
  const manual = snapshot.settings.answerMode === "manual";
  const { run, pending } = useCEEAction();
  const starting = pending.has("cee.game.start");
  const readying = pending.has("cee.player.ready");
  const [roomOpen, setRoomOpen] = useState(false);

  // 房间设置的草稿：名称、是否公开、是否允许旁观与私密密码。
  const [roomDraft, setRoomDraft] = useState<RoomDraft>(() => ({
    name: snapshot.name,
    visibility: snapshot.visibility,
    allowSpectators: snapshot.allowSpectators,
    password: "",
  }));
  const [roomNotice, setRoomNotice] = useState("");

  const roomValidation = roomValidationText(snapshot.source, roomDraft, snapshot.hasPassword);

  useAutoSave(
    roomDraft,
    async (value) => {
      await useCEEStore.getState().sendCommand("cee.room.update", {
        name: value.name.trim(),
        visibility: value.visibility,
        allowSpectators: value.allowSpectators,
        password: value.password.trim() || null,
      });
      setRoomNotice("");
    },
    {
      enabled:
        isHost && snapshot.phase === "waiting" && !roomValidation && Boolean(roomDraft.name.trim()),
      onError: (error) => setRoomNotice(ceeErrorMessage(error)),
    }
  );

  // 新建房间的首次进房：先套用上局的玩法设置（标记匹配才触发），落定前不让设置面板先挂载。
  const restoring = useRoomSettingsRestore("cee", snapshot.roomId, (memory) =>
    restoreCEESettings(memory)
  );
  if (restoring) return <RoomRestoreFallback />;

  const editRoom = <K extends keyof RoomDraft>(key: K, value: RoomDraft[K]) =>
    setRoomDraft((current) => ({ ...current, [key]: value }));

  return (
    <div className="mx-auto w-full max-w-md space-y-5">
      <PhaseHeader icon={Gamepad2} title={isHost ? "等待玩家加入" : "等待开始"} />

      <RoomLinkShare
        path={ceeRoomPath(snapshot.roomId)}
        onCopyError={() => useCEEStore.getState().setNotice("复制失败，请手动复制", "error")}
      />

      {others.length ? (
        <ReadyProgress
          ready={readyCount}
          total={others.length}
          variant={isHost ? "host" : "guest"}
        />
      ) : null}

      <CEETeamPicker snapshot={snapshot} privateState={privateState} />

      <SettingsStack>
        <CEEGameSettings
          settings={snapshot.settings}
          source={snapshot.source}
          waiting={snapshot.phase === "waiting"}
          readOnly={!isHost}
        />

        <RoomSettingsSection
          snapshot={snapshot}
          isHost={isHost}
          draft={roomDraft}
          validation={roomValidation}
          notice={roomNotice}
          open={roomOpen}
          onOpenChange={setRoomOpen}
          onEdit={editRoom}
        />
      </SettingsStack>

      <WaitingActions
        isHost={isHost}
        me={me}
        canStart={privateState.canStart}
        manual={manual}
        starting={starting}
        readying={readying}
        readyCount={readyCount}
        otherCount={others.length}
        onStart={() => void run("cee.game.start", {})}
        onToggleReady={(ready) => void run("cee.player.ready", { ready: !ready })}
      />
    </div>
  );
}
