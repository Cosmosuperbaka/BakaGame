/* eslint-disable react-refresh/only-export-components -- 恢复函数与等待页共享同一份目录同步规则，放一起改动时不会漏掉一边。 */
import { useState } from "react";
import { Check, Eye, EyeOff, Gamepad2, Settings, X } from "lucide-react";
import type { CEEPrivateState, CEERoomSnapshot } from "@bakagame/shared";
import { Button } from "@/components/ui/Button";
import { PhaseHeader } from "@/components/common/PhaseHeader";
import { ReadyProgress } from "@/components/common/room/ReadyProgress";
import { RoomLinkShare } from "@/components/common/room/RoomLinkShare";
import { McpSettingsSection } from "@/components/common/room/McpSettingsSection";
import { RoomRestoreFallback } from "@/components/common/room/RoomRestoreFallback";
import { SettingsAccordion, SettingsStack } from "@/components/common/room/SettingsAccordion";
import { SettingsFields } from "@/components/common/room/settings/Layout";
import { SettingSwitchRow } from "@/components/common/room/settings/ChoiceFields";
import { RoomBasicsFields, type RoomBasicsValues } from "@/components/common/room/RoomBasicsFields";
import { useAutoSave } from "@/hooks/UseAutoSave";
import { useCEEAction } from "@/hooks/UseCEEAction";
import { useRoomSettingsRestore } from "@/hooks/UseRoomSettingsRestore";
import { ceeErrorMessage, useCEEStore } from "@/stores/UseCEEStore";
import { ceeRoomPath } from "@/lib/CEESession";
import { updateRoomSettingsMemory, type CEERoomSettingsMemory } from "@/lib/RoomSettingsMemory";
import { CEEGameSettings } from "./CEEGameSettings";
import { CEETeamPicker } from "./CEETeamPicker";
import { waitingSnapshotOf } from "./CEEWaitingSave";
import { useCEEDraft } from "./UseCEEDraft";

/**
 * 套用上局的玩法设置：用了 Bangumi 目录时先同步入库（服务端只从已落库的成员出题），
 * 目录同步失败即整体放弃——宁可用服务端默认值，也不要一份抽不出题的设置。
 */
export async function restoreCEESettings(memory: CEERoomSettingsMemory): Promise<void> {
  const { settings } = memory;
  if (settings.useIndex && settings.indexId !== null) {
    await useCEEStore.getState().sendCommand("cee.directory.import", { indexId: settings.indexId });
  }
  // MCP 开关属于房间级独立设置，不从上一局的玩法记忆里继承；沿用本次建房得到的值。
  const allowAgents = useCEEStore.getState().snapshot?.settings.allowAgents === true;
  await useCEEStore
    .getState()
    .sendCommand("cee.room.settings", { settings: { ...settings, allowAgents } });
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

/**
 * 反作弊房里旁观要房主逐个批准，批准过的旁观者局中可见答案，房间开关不参与判定：
 * 这一项在那里恒为开启、不可改，摘要与说明都改说「由审批把关」。其余增强房读房间设置。
 */
const seeAnswersOf = (snapshot: CEERoomSnapshot): boolean =>
  snapshot.bakaAntiCheat || snapshot.settings.spectatorsSeeAnswers === true;

const seeAnswersSummary = (snapshot: CEERoomSnapshot): string => {
  if (snapshot.bakaAntiCheat) return "旁观经批准可见答案";
  return seeAnswersOf(snapshot) ? "旁观可见答案" : "旁观隐藏答案";
};

const seeAnswersDescription = (snapshot: CEERoomSnapshot): string =>
  snapshot.bakaAntiCheat
    ? "反作弊房由旁观审批把关：房主批准的旁观者局中可见答案，其余人要等揭晓。"
    : "局中把答案与全场猜测发给旁观者与中途加入的人；关闭时他们看不到答案，揭晓后照常公开。";

/** 折叠面板收起时显示的摘要，与面板里的开关口径一致；原版房没有「旁观可见答案」这一项。 */
const roomSummaryLines = (snapshot: CEERoomSnapshot): string[] => [
  snapshot.visibility === "private"
    ? snapshot.source === "original"
      ? "不在大厅显示"
      : "私密房间"
    : "公开房间",
  snapshot.allowSpectators ? "允许旁观" : "不允许旁观",
  snapshot.source === "native" ? seeAnswersSummary(snapshot) : "",
];

/**
 * 旁观可见答案是玩法设置里的一项，但摆在房间设置里（与卧底、猜歌同位）：它不进题目与猜测的草稿，
 * 开关一动就把「房间里当前的整份设置」改这一项后发出，玩法设置的自动保存也始终沿用房间里的当前值。
 * 下次建房的记忆跟着记，没有记忆时以当前设置起一份（MCP 开关属于房间级，不进记忆）。
 */
async function saveSpectatorsSeeAnswers(roomId: string, value: boolean): Promise<void> {
  const live = waitingSnapshotOf(roomId);
  if (!live) return;
  await useCEEStore.getState().sendCommand("cee.room.settings", {
    settings: { ...live.settings, spectatorsSeeAnswers: value },
  });
  updateRoomSettingsMemory("cee", (current) => ({
    settings: {
      ...(current?.settings ?? { ...live.settings, allowAgents: false }),
      spectatorsSeeAnswers: value,
    },
  }));
}

/**
 * MCP 开关是房间级设置，不进玩法草稿：点一下就把房间里当前的整份设置改这一项后发出。
 * 读的是点击那一刻的快照，不是渲染时的 props，免得把别处刚改过的设置写回旧值。
 */
async function saveAllowAgents(value: boolean): Promise<void> {
  const snapshot = useCEEStore.getState().snapshot;
  if (!snapshot) throw new Error("尚未收到房间快照");
  await useCEEStore.getState().sendCommand("cee.room.settings", {
    settings: { ...snapshot.settings, allowAgents: value },
  });
}

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
  /** 旁观可见答案：不进草稿，改一下就保存。 */
  seeAnswersPending: boolean;
  onSeeAnswersChange: (value: boolean) => void;
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
  seeAnswersPending,
  onSeeAnswersChange,
}: RoomSettingsSectionProps) {
  // 非房主读当前快照；房主读草稿。
  const roomValues = isHost
    ? draft
    : { visibility: snapshot.visibility, allowSpectators: snapshot.allowSpectators };
  const native = snapshot.source === "native";
  const basics: RoomBasicsValues = {
    name: isHost ? draft.name : snapshot.name,
    isPrivate: roomValues.visibility === "private",
    password: draft.password,
    allowSpectators: roomValues.allowSpectators,
  };
  // 基础字段块用 isPrivate 表达私密，CEE 草稿存的是 visibility，这里把开关翻译回草稿口径。
  const editBasics = <K extends keyof RoomBasicsValues>(key: K, value: RoomBasicsValues[K]) => {
    switch (key) {
      case "name":
        return onEdit("name", value as string);
      case "password":
        return onEdit("password", value as string);
      case "allowSpectators":
        return onEdit("allowSpectators", value as boolean);
      case "isPrivate":
        return onEdit("visibility", value ? "private" : "public");
    }
  };

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
        <RoomBasicsFields
          values={basics}
          onEdit={editBasics}
          nameMaxLength={snapshot.source === "original" ? 30 : 32}
          privacy={snapshot.source === "original" ? "unlisted" : "password"}
          passwordField={isHost && native}
          hasPassword={snapshot.hasPassword}
          spectatorsField={native}
        >
          {native ? (
            <SettingSwitchRow
              label="旁观者可见答案"
              description={seeAnswersDescription(snapshot)}
              icon={seeAnswersOf(snapshot) ? Eye : EyeOff}
              checked={seeAnswersOf(snapshot)}
              disabled={seeAnswersPending || snapshot.bakaAntiCheat}
              onCheckedChange={onSeeAnswersChange}
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
        </RoomBasicsFields>
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
        data-agent-control="cee.start"
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
        className="min-w-30 gap-2"
        disabled={readying}
        loading={readying}
        onClick={() => onToggleReady(activeMe.ready)}
        data-agent-control="cee.ready"
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

  // 房间设置的草稿：名称、是否公开、是否允许旁观与私密密码。随房主身份与服务端当前值同步，见 useCEEDraft。
  const { draft: roomDraft, setDraft: setRoomDraft } = useCEEDraft<RoomDraft>(
    {
      name: snapshot.name,
      visibility: snapshot.visibility,
      allowSpectators: snapshot.allowSpectators,
      password: "",
    },
    isHost
  );
  const [roomNotice, setRoomNotice] = useState("");
  const [seeAnswersPending, setSeeAnswersPending] = useState(false);
  const changeSeeAnswers = (value: boolean) => {
    setSeeAnswersPending(true);
    saveSpectatorsSeeAnswers(snapshot.roomId, value)
      .then(() => setRoomNotice(""))
      .catch((error: unknown) => setRoomNotice(ceeErrorMessage(error)))
      .finally(() => setSeeAnswersPending(false));
  };

  const roomValidation = roomValidationText(snapshot.source, roomDraft, snapshot.hasPassword);

  useAutoSave(
    roomDraft,
    async (value) => {
      const live = waitingSnapshotOf(snapshot.roomId);
      if (!live) return;
      // 草稿被重置为服务端当前值后与之相同，没有要保存的内容，不再原样写一遍。
      if (
        !value.password.trim() &&
        value.name.trim() === live.name &&
        value.visibility === live.visibility &&
        value.allowSpectators === live.allowSpectators
      )
        return;
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
        onCopyError={() => useCEEStore.getState().showToast("复制失败，请手动复制", "error")}
      />

      {others.length ? (
        <ReadyProgress
          ready={readyCount}
          total={others.length}
          variant={isHost ? "host" : "guest"}
        />
      ) : null}

      <div data-agent-control="cee.team">
        <CEETeamPicker snapshot={snapshot} privateState={privateState} />
      </div>

      <SettingsStack>
        <CEEGameSettings
          roomId={snapshot.roomId}
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
          seeAnswersPending={seeAnswersPending}
          onSeeAnswersChange={changeSeeAnswers}
        />

        {snapshot.source === "native" ? (
          <McpSettingsSection
            allowAgents={snapshot.settings.allowAgents === true}
            isHost={isHost}
            onChangeAllowAgents={saveAllowAgents}
          />
        ) : null}
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
