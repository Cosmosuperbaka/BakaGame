import { useState } from "react";
import { motion } from "framer-motion";
import {
  Check,
  Copy,
  Gamepad2,
  Headphones,
  Link,
  Music2,
  Settings,
  X,
} from "lucide-react";
import { Button } from "@/components/ui/Button";
import { Label } from "@/components/ui/Label";
import { PhaseHeader } from "@/components/common/PhaseHeader";
import { SongAccountSettings } from "@/components/songuessr/SongAccountSettings";
import {
  SettingsAccordion,
  SongGameSettings,
  SongQuestionSettings,
  SongRoomSettings,
  SongSettingsPreview,
} from "@/components/songuessr/settings/SongSettingsPanels";
import { pressable, spring } from "@/lib/Motion";
import { cn } from "@/lib/Utils";
import { useSonGuessrStore } from "@/stores/UseSonGuessrStore";
import type { SonGuessrPlayerView, SonGuessrRoomSnapshot } from "@/types";

export function SongRoomLinkShare({ roomId }: { roomId: string }) {
  const [copied, setCopied] = useState(false);
  const setNotice = useSonGuessrStore((state) => state.setNotice);
  const shareUrl = `${window.location.origin}/songuessr/room/${roomId}`;

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(shareUrl);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 2_000);
    } catch {
      setNotice("复制失败，请手动复制", "error");
    }
  };

  return (
    <div className="w-full space-y-2">
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
          onClick={() => void handleCopy()}
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
  );
}

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
        icon={<Music2 className="h-4 w-4 text-muted-foreground" />}
        title="题目设置"
        open={questionSettingsOpen}
        onOpenChange={setQuestionSettingsOpen}
      >
        <SongQuestionSettings snapshot={snapshot} solo />
      </SettingsAccordion>
      <SettingsAccordion
        icon={<Settings className="h-4 w-4 text-muted-foreground" />}
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

      <SongRoomLinkShare roomId={snapshot.roomId} />

      {showProgress ? (
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
      ) : null}

      <SongAccountSettings snapshot={snapshot} />

      <SettingsAccordion
        icon={<Music2 className="h-4 w-4 text-muted-foreground" />}
        title="题目设置"
        open={questionSettingsOpen}
        onOpenChange={setQuestionSettingsOpen}
      >
        <SongQuestionSettings snapshot={snapshot} />
      </SettingsAccordion>

      <SettingsAccordion
        icon={<Settings className="h-4 w-4 text-muted-foreground" />}
        title="猜测设置"
        open={gameSettingsOpen}
        onOpenChange={setGameSettingsOpen}
      >
        <SongGameSettings snapshot={snapshot} />
      </SettingsAccordion>

      <SettingsAccordion
        icon={<Settings className="h-4 w-4 text-muted-foreground" />}
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
      <SongRoomLinkShare roomId={snapshot.roomId} />
      <SongSettingsPreview snapshot={snapshot} />
      {showProgress ? (
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
      ) : null}
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
