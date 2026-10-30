import { useState } from "react";
import { Check, Gamepad2, Headphones, Music2, Search, Settings, X } from "lucide-react";
import { Button } from "@/components/ui/Button";
import { PhaseHeader } from "@/components/common/PhaseHeader";
import { ReadyProgress } from "@/components/common/room/ReadyProgress";
import { RoomLinkShare } from "@/components/common/room/RoomLinkShare";
import { McpSettingsSection } from "@/components/common/room/McpSettingsSection";
import { RoomRestoreFallback } from "@/components/common/room/RoomRestoreFallback";
import { TeamPicker } from "@/components/common/room/TeamPicker";
import { SettingsAccordion, SettingsStack } from "@/components/common/room/SettingsAccordion";
import { SongAccountSettings } from "@/components/songuessr/SongAccountSettings";
import { SongMusicPoolPanel } from "@/components/songuessr/SongMusicPoolPanel";
import {
  SongGameSettings,
  SongQuestionSettings,
  SongRoomSettings,
  songSettingsSummary,
} from "@/components/songuessr/settings/SongSettingsPanels";
import { useRoomSettingsRestore } from "@/hooks/UseRoomSettingsRestore";
import { useSonGuessrStore } from "@/stores/UseSonGuessrStore";
import { hasMusicAccount } from "@bakagame/shared";
import type { SonGuessrPlayerView, SonGuessrRoomSnapshot } from "@bakagame/shared";
import type { SongRunCommand } from "@/hooks/UseSongRoomLifecycle";

const notifyCopyFailed = () =>
  useSonGuessrStore.getState().showToast("复制失败，请手动复制", "error");

/**
 * 三组折叠设置，房主、单人与其他玩家共用同一份结构：收起时各有摘要，`readOnly` 时字段只显示取值。
 * 单人模式没有房间设置，但保留 MCP 接入——把唯一那个座位交给 Agent 是单人练习的合法用法。
 * 账号组（`account`）在等待阶段对所有玩家都可编辑：B4 之后账号池由房内
 * 成员各自贡献，谁都能登录自己的号并决定要不要共享给本房，不只是房主。`readOnly` 只管设置组。
 */
function SongSettingsGroups({
  snapshot,
  me,
  solo = false,
  readOnly = false,
  account = false,
}: {
  snapshot: SonGuessrRoomSnapshot;
  me?: SonGuessrPlayerView;
  solo?: boolean;
  readOnly?: boolean;
  account?: boolean;
}) {
  const [questionOpen, setQuestionOpen] = useState(false);
  const [gameOpen, setGameOpen] = useState(false);
  const [roomOpen, setRoomOpen] = useState(false);
  const summary = songSettingsSummary(snapshot);
  return (
    <SettingsStack>
      {account ? <SongAccountSettings snapshot={snapshot} me={me} /> : null}
      <SettingsAccordion
        icon={Music2}
        title="题目设置"
        summary={summary.question}
        readOnly={readOnly}
        open={questionOpen}
        onOpenChange={setQuestionOpen}
      >
        <SongQuestionSettings snapshot={snapshot} solo={solo} readOnly={readOnly} />
      </SettingsAccordion>
      <SettingsAccordion
        icon={Search}
        title="猜测设置"
        summary={summary.game}
        readOnly={readOnly}
        open={gameOpen}
        onOpenChange={setGameOpen}
      >
        <SongGameSettings snapshot={snapshot} solo={solo} readOnly={readOnly} />
      </SettingsAccordion>
      {!solo ? (
        <SettingsAccordion
          icon={Settings}
          title="房间设置"
          summary={summary.room}
          readOnly={readOnly}
          open={roomOpen}
          onOpenChange={setRoomOpen}
        >
          <SongRoomSettings snapshot={snapshot} readOnly={readOnly} />
        </SettingsAccordion>
      ) : null}
      {/* 单人房同样可以交给 Agent：房里只有自己那一个座位，凭证仍是自己的会话。 */}
      <McpSettingsSection
        game="song"
        roomId={snapshot.roomId}
        allowAgents={snapshot.settings.allowAgents === true}
        isHost={!readOnly}
      />
    </SettingsStack>
  );
}

/** 等待页的队伍面板：只给参与者，旁观者没有队伍。同队共用次数、记录与限时，一人猜中全队结束。 */
function SongTeamPicker({
  snapshot,
  me,
  run,
  isPending,
}: {
  snapshot: SonGuessrRoomSnapshot;
  me?: SonGuessrPlayerView;
  run: SongRunCommand;
  isPending?: (type: string) => boolean;
}) {
  if (!me || me.membership !== "active") return null;
  return (
    <div data-agent-control="song.team">
      <TeamPicker
        players={snapshot.players.filter((player) => player.membership === "active")}
        selfId={me.id}
        switching={Boolean(isPending?.("song.player.setTeam"))}
        hint="同队共享次数与猜测"
        onPick={(team) => void run("song.player.setTeam", { team })}
      />
    </div>
  );
}

export function SongSoloWaitingPanel({
  snapshot,
  me,
  run,
  isPending,
}: {
  snapshot: SonGuessrRoomSnapshot;
  me?: SonGuessrPlayerView;
  run: SongRunCommand;
  isPending?: (type: string) => boolean;
}) {
  const isStarting = Boolean(isPending?.("song.game.start"));
  const canStartSolo = hasMusicAccount(snapshot);

  return (
    <div className="mx-auto w-full max-w-md space-y-5">
      <PhaseHeader icon={Headphones} title="准备开始" />
      <SongSettingsGroups snapshot={snapshot} me={me} solo account />
      <Button
        size="lg"
        disabled={!canStartSolo || isStarting}
        loading={isStarting}
        onClick={() => void run("song.game.start")}
        className="w-full text-base"
        data-agent-control="song.start"
      >
        {canStartSolo ? "开始游戏" : "请先登录网易云或 QQ 音乐账号"}
      </Button>
    </div>
  );
}

export function SongHostWaitingPanel({
  snapshot,
  me,
  noCandidate = false,
  showProgress,
  readyCount,
  nonHostTotal,
  allReady,
  canStart,
  run,
  isPending,
}: {
  snapshot: SonGuessrRoomSnapshot;
  me?: SonGuessrPlayerView;
  /** 手动出题且没有可指定的出题人（组队后谁出题都会让整队观战、留不下猜歌的人） */
  noCandidate?: boolean;
  showProgress: boolean;
  readyCount: number;
  nonHostTotal: number;
  allReady: boolean;
  canStart: boolean;
  run: SongRunCommand;
  isPending?: (type: string) => boolean;
}) {
  const isStarting = Boolean(isPending?.("song.game.start"));

  return (
    <div className="mx-auto w-full max-w-md space-y-5">
      <PhaseHeader icon={Gamepad2} title="等待玩家加入" />

      <RoomLinkShare path={`/songuessr/room/${snapshot.roomId}`} onCopyError={notifyCopyFailed} />

      {showProgress ? (
        <ReadyProgress ready={readyCount} total={nonHostTotal} variant="host" />
      ) : null}

      <SongTeamPicker snapshot={snapshot} me={me} run={run} isPending={isPending} />

      <SongSettingsGroups snapshot={snapshot} me={me} account />

      <SongMusicPoolPanel snapshot={snapshot} />

      <Button
        size="lg"
        disabled={!canStart || noCandidate || isStarting}
        loading={isStarting}
        onClick={() => void run("song.game.start")}
        className="w-full text-base"
        data-agent-control="song.start"
      >
        {!hasMusicAccount(snapshot) && allReady
          ? "请先登录网易云或 QQ 音乐账号"
          : allReady && noCandidate
            ? "暂无可选出题人"
            : allReady
              ? "开始游戏"
              : nonHostTotal === 0
                ? "等待玩家加入"
                : `等待玩家准备 (${readyCount}/${nonHostTotal})`}
      </Button>
    </div>
  );
}

export interface SongWaitingPhaseProps {
  snapshot: SonGuessrRoomSnapshot;
  me?: SonGuessrPlayerView;
  isHost: boolean;
  /** 房主在手动出题时收到的可选出题人（见 `SonGuessrPrivateState.submitterCandidateIds`） */
  submitterCandidateIds?: string[];
  run: SongRunCommand;
  isPending?: (type: string) => boolean;
}

export function SongWaitingPhase({
  snapshot,
  me,
  isHost,
  submitterCandidateIds,
  run,
  isPending,
}: SongWaitingPhaseProps) {
  // 新建房间的首次进房：先套用上次的房间内设置（标记匹配才触发），落定前不让设置面板先挂载。
  const restoring = useRoomSettingsRestore("song", snapshot.roomId, async (memory) => {
    await useSonGuessrStore
      .getState()
      .sendCommand("song.room.updateSettings", { ...memory.question, ...memory.game });
  });
  if (restoring) return <RoomRestoreFallback />;

  if (snapshot.solo) {
    return <SongSoloWaitingPanel snapshot={snapshot} me={me} run={run} isPending={isPending} />;
  }

  const activePlayers = snapshot.players.filter((player) => player.membership === "active");
  const nonHostActive = activePlayers.filter((player) => !player.isHost);
  const readyCount = nonHostActive.filter((player) => player.isReady).length;
  const showProgress = nonHostActive.length > 0;
  const allReady = activePlayers.length >= 2 && nonHostActive.every((player) => player.isReady);
  const isReadyPending = Boolean(isPending?.("song.player.setReady"));

  if (isHost) {
    return (
      <SongHostWaitingPanel
        snapshot={snapshot}
        me={me}
        noCandidate={
          snapshot.settings.questionMode !== "automatic" && submitterCandidateIds?.length === 0
        }
        showProgress={showProgress}
        readyCount={readyCount}
        nonHostTotal={nonHostActive.length}
        allReady={allReady}
        canStart={allReady && hasMusicAccount(snapshot)}
        run={run}
        isPending={isPending}
      />
    );
  }

  return (
    <div className="mx-auto w-full max-w-md space-y-5">
      <PhaseHeader icon={Gamepad2} title="等待开始" />
      <RoomLinkShare path={`/songuessr/room/${snapshot.roomId}`} onCopyError={notifyCopyFailed} />
      {showProgress ? (
        <ReadyProgress ready={readyCount} total={nonHostActive.length} variant="guest" />
      ) : null}
      <SongTeamPicker snapshot={snapshot} me={me} run={run} isPending={isPending} />
      {/* 与非房主同一份设置结构，只读；账号组是可编辑的：B4 里每个玩家都能贡献自己的号。 */}
      <SongSettingsGroups snapshot={snapshot} me={me} readOnly account />
      {me?.membership === "active" ? (
        <div className="flex justify-center">
          <Button
            variant={me.isReady ? "outline" : "default"}
            size="lg"
            disabled={isReadyPending}
            loading={isReadyPending}
            onClick={() => void run("song.player.setReady", { ready: !me.isReady })}
            className="gap-2 min-w-[120px]"
            data-agent-control="song.ready"
          >
            {me.isReady ? (
              <>{isReadyPending ? null : <X className="h-4 w-4" />}取消准备</>
            ) : (
              <>{isReadyPending ? null : <Check className="h-4 w-4" />}准备</>
            )}
          </Button>
        </div>
      ) : null}
    </div>
  );
}
