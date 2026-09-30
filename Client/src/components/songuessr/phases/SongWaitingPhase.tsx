import { useState } from "react";
import { Check, Gamepad2, Headphones, Music2, Settings, X } from "lucide-react";
import { Button } from "@/components/ui/Button";
import { PhaseHeader } from "@/components/common/PhaseHeader";
import { ReadyProgress } from "@/components/common/room/ReadyProgress";
import { RoomLinkShare } from "@/components/common/room/RoomLinkShare";
import { SettingsAccordion } from "@/components/common/room/SettingsAccordion";
import { SongAccountSettings } from "@/components/songuessr/SongAccountSettings";
import {
  SongGameSettings,
  SongQuestionSettings,
  SongRoomSettings,
  SongSettingsPreview,
} from "@/components/songuessr/settings/SongSettingsPanels";
import { useSonGuessrStore } from "@/stores/UseSonGuessrStore";
import type { SonGuessrPlayerView, SonGuessrRoomSnapshot } from "@/types";

const notifyCopyFailed = () => useSonGuessrStore.getState().setNotice("复制失败，请手动复制", "error");

export function SongSoloWaitingPanel({
  snapshot,
  run,
  isPending,
}: {
  snapshot: SonGuessrRoomSnapshot;
  run: (type: string, payload?: Record<string, unknown>, success?: string) => Promise<void>;
  isPending?: (type: string) => boolean;
}) {
  const [questionSettingsOpen, setQuestionSettingsOpen] = useState(false);
  const [gameSettingsOpen, setGameSettingsOpen] = useState(false);
  const isStarting = Boolean(isPending?.("song.game.start"));

  return (
    <div className="mx-auto w-full max-w-md space-y-5">
      <PhaseHeader icon={Headphones} title="准备开始" />
      <SongAccountSettings snapshot={snapshot} />
      <SettingsAccordion
        icon={Music2}
        title="题目设置"
        open={questionSettingsOpen}
        onOpenChange={setQuestionSettingsOpen}
      >
        <SongQuestionSettings snapshot={snapshot} solo />
      </SettingsAccordion>
      <SettingsAccordion
        icon={Settings}
        title="猜测设置"
        open={gameSettingsOpen}
        onOpenChange={setGameSettingsOpen}
      >
        <SongGameSettings snapshot={snapshot} solo />
      </SettingsAccordion>
      <Button
        size="lg"
        disabled={!snapshot.musicAccountReady || isStarting}
        loading={isStarting}
        onClick={() => void run("song.game.start")}
        className="w-full text-base"
      >
        {isStarting
          ? "正在开始游戏..."
          : snapshot.musicAccountReady
            ? "开始游戏"
            : "请先扫码登录网易云账号"}
      </Button>
    </div>
  );
}

export function SongHostWaitingPanel({
  snapshot,
  showProgress,
  readyCount,
  nonHostTotal,
  allReady,
  canStart,
  run,
  isPending,
}: {
  snapshot: SonGuessrRoomSnapshot;
  showProgress: boolean;
  readyCount: number;
  nonHostTotal: number;
  allReady: boolean;
  canStart: boolean;
  run: (type: string, payload?: Record<string, unknown>, success?: string) => Promise<void>;
  isPending?: (type: string) => boolean;
}) {
  const [questionSettingsOpen, setQuestionSettingsOpen] = useState(false);
  const [gameSettingsOpen, setGameSettingsOpen] = useState(false);
  const [roomSettingsOpen, setRoomSettingsOpen] = useState(false);
  const isStarting = Boolean(isPending?.("song.game.start"));

  return (
    <div className="mx-auto w-full max-w-md space-y-5">
      <PhaseHeader icon={Gamepad2} title="等待玩家加入" />

      <RoomLinkShare path={`/songuessr/room/${snapshot.roomId}`} onCopyError={notifyCopyFailed} />

      {showProgress ? <ReadyProgress ready={readyCount} total={nonHostTotal} variant="host" /> : null}

      <SongAccountSettings snapshot={snapshot} />

      <SettingsAccordion
        icon={Music2}
        title="题目设置"
        open={questionSettingsOpen}
        onOpenChange={setQuestionSettingsOpen}
      >
        <SongQuestionSettings snapshot={snapshot} />
      </SettingsAccordion>

      <SettingsAccordion
        icon={Settings}
        title="猜测设置"
        open={gameSettingsOpen}
        onOpenChange={setGameSettingsOpen}
      >
        <SongGameSettings snapshot={snapshot} />
      </SettingsAccordion>

      <SettingsAccordion
        icon={Settings}
        title="房间设置"
        open={roomSettingsOpen}
        onOpenChange={setRoomSettingsOpen}
      >
        <SongRoomSettings snapshot={snapshot} />
      </SettingsAccordion>

      <Button
        size="lg"
        disabled={!canStart || isStarting}
        loading={isStarting}
        onClick={() => void run("song.game.start")}
        className="w-full text-base"
      >
        {isStarting
          ? "正在开始游戏..."
          : !snapshot.musicAccountReady && allReady
          ? "请先扫码登录网易云账号"
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
  run: (type: string, payload?: Record<string, unknown>, success?: string) => Promise<void>;
  isPending?: (type: string) => boolean;
}

export function SongWaitingPhase({
  snapshot,
  me,
  isHost,
  run,
  isPending,
}: SongWaitingPhaseProps) {
  if (snapshot.solo) {
    return <SongSoloWaitingPanel snapshot={snapshot} run={run} isPending={isPending} />;
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
        showProgress={showProgress}
        readyCount={readyCount}
        nonHostTotal={nonHostActive.length}
        allReady={allReady}
        canStart={allReady && snapshot.musicAccountReady}
        run={run}
        isPending={isPending}
      />
    );
  }

  return (
    <div className="mx-auto flex max-w-md flex-col items-center gap-6">
      <PhaseHeader icon={Gamepad2} title="等待开始" />
      <RoomLinkShare path={`/songuessr/room/${snapshot.roomId}`} onCopyError={notifyCopyFailed} />
      <SongSettingsPreview snapshot={snapshot} />
      {showProgress ? <ReadyProgress ready={readyCount} total={nonHostActive.length} variant="guest" /> : null}
      {me?.membership === "active" ? (
        <Button
          variant={me.isReady ? "outline" : "default"}
          size="lg"
          disabled={isReadyPending}
          loading={isReadyPending}
          onClick={() => void run("song.player.setReady", { ready: !me.isReady })}
          className="gap-2 min-w-[120px]"
        >
          {isReadyPending ? (
            me.isReady ? "正在取消..." : "正在准备..."
          ) : me.isReady ? (
            <><X className="h-4 w-4" />取消准备</>
          ) : (
            <><Check className="h-4 w-4" />准备</>
          )}
        </Button>
      ) : null}
    </div>
  );
}
