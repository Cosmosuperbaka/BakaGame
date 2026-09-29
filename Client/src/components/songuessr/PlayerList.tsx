import { useCallback } from "react";
import { AnimatePresence, motion } from "framer-motion";
import { ScrollArea } from "@/components/ui/ScrollArea";
import { PlayerRow, hostActions } from "@/components/common/PlayerRow";
import { PlayerGroupTitle, PlayerStatusPill, type PlayerStatusTone } from "@/components/common/PlayerStatusPill";
import { SpectatorToggle } from "@/components/common/SpectatorToggle";
import { listContainer } from "@/lib/Motion";
import { useSonGuessrStore } from "@/stores/UseSonGuessrStore";
import type { SonGuessrPhase, SonGuessrPlayerView } from "@/types";

type SongStatus = {
  label: string;
  tone: PlayerStatusTone;
};

export interface PlayerListProps {
  players: SonGuessrPlayerView[];
  myPlayerId?: string;
  isHost: boolean;
  phase: SonGuessrPhase;
  allowSpectators: boolean;
}

export function PlayerList({
  players,
  myPlayerId,
  isHost,
  phase,
  allowSpectators,
}: PlayerListProps) {
  const sendCommand = useSonGuessrStore((state) => state.sendCommand);
  const setNotice = useSonGuessrStore((state) => state.setNotice);
  const activePlayers = players.filter((player) => player.membership === "active");
  const observers = players.filter((player) => player.membership === "spectator");
  const me = players.find((player) => player.id === myPlayerId);
  const waitingPhase = phase === "waiting";
  const canJoinSpectators =
    Boolean(me) &&
    allowSpectators &&
    me?.membership === "active";
  const canJoinPlayers = me?.membership === "spectator";

  const handleKick = useCallback(
    async (playerId: string) => {
      try {
        await sendCommand("song.room.kick", { playerId });
      } catch (error) {
        setNotice((error as { message: string }).message, "error");
      }
    },
    [sendCommand, setNotice],
  );

  const handleTransferHost = useCallback(
    async (playerId: string) => {
      try {
        await sendCommand("song.room.transferHost", { playerId });
      } catch (error) {
        setNotice((error as { message: string }).message, "error");
      }
    },
    [sendCommand, setNotice],
  );

  const handleSetSpectator = useCallback(
    async (spectator: boolean) => {
      try {
        await sendCommand("song.player.setSpectator", { spectator });
      } catch (error) {
        setNotice((error as { message: string }).message, "error");
      }
    },
    [sendCommand, setNotice],
  );

  const renderRow = (player: SonGuessrPlayerView, hideSpectatorStatus: boolean) => (
    <SongPlayerRow
      key={player.id}
      player={player}
      myPlayerId={myPlayerId}
      isHostViewer={isHost}
      phase={phase}
      hideSpectatorStatus={hideSpectatorStatus}
      onKick={handleKick}
      onTransferHost={handleTransferHost}
    />
  );

  return (
    <ScrollArea className="h-full">
      <div className="min-w-0 px-2">
        <div className="relative flex min-w-0 w-full flex-col py-3">
          <PlayerGroupTitle label="玩家" count={activePlayers.length} />
          <motion.div
            className="flex flex-col gap-px"
            variants={listContainer(activePlayers.length)}
            initial={false}
            animate="animate"
          >
            <AnimatePresence initial={false}>
              {activePlayers.map((player) => renderRow(player, false))}
            </AnimatePresence>
          </motion.div>

          {canJoinPlayers ? (
            <SpectatorToggle
              spectator={false}
              queued={!waitingPhase}
              selected={me?.nextRoundMembership === "active"}
              onToggle={handleSetSpectator}
            />
          ) : null}

          {observers.length > 0 || canJoinSpectators ? (
            <>
              <PlayerGroupTitle label="旁观" count={observers.length} withRule />
              <motion.div
                className="flex flex-col gap-px"
                variants={listContainer(observers.length)}
                initial={false}
                animate="animate"
              >
                <AnimatePresence initial={false}>
                  {observers.map((player) => renderRow(player, true))}
                </AnimatePresence>
              </motion.div>
              {canJoinSpectators ? (
                <SpectatorToggle
                  spectator
                  queued={!waitingPhase}
                  selected={me?.nextRoundMembership === "spectator"}
                  onToggle={handleSetSpectator}
                />
              ) : null}
            </>
          ) : null}
        </div>
      </div>
    </ScrollArea>
  );
}

interface SongPlayerRowProps {
  player: SonGuessrPlayerView;
  myPlayerId?: string;
  isHostViewer: boolean;
  phase: SonGuessrPhase;
  hideSpectatorStatus: boolean;
  onKick: (playerId: string) => void;
  onTransferHost: (playerId: string) => void;
}

function SongPlayerRow({
  player,
  myPlayerId,
  isHostViewer,
  phase,
  hideSpectatorStatus,
  onKick,
  onTransferHost,
}: SongPlayerRowProps) {
  const isMe = player.id === myPlayerId;
  const canManage = isHostViewer && !isMe;
  const canTransfer = canManage && player.membership === "active" && player.online && !player.isBot;
  const status = resolveSongStatus(player, phase, hideSpectatorStatus);
  const actions = canManage
    ? hostActions({
        ...(canTransfer ? { onTransferHost: () => onTransferHost(player.id) } : {}),
        onKick: () => onKick(player.id),
      })
    : undefined;

  return (
    <PlayerRow
      name={player.name}
      score={player.score}
      me={isMe}
      host={player.isHost}
      online={player.online}
      bot={player.isBot}
      badges={status ? <PlayerStatusPill {...status} /> : null}
      actions={actions}
    />
  );
}

function resolveSongStatus(
  player: SonGuessrPlayerView,
  phase: SonGuessrPhase,
  hideSpectatorStatus: boolean,
): SongStatus | null {
  if (player.membership === "spectator") {
    return hideSpectatorStatus ? null : { label: "旁观", tone: "default" };
  }
  if (phase === "waiting") {
    return player.isReady
      ? { label: "准备", tone: "success" }
      : { label: "等待", tone: "default" };
  }
  if (player.roundStatus === "submitter") return { label: "出题", tone: "questioner" };
  if (player.roundStatus === "guessing") return { label: "猜歌", tone: "warning" };
  if (player.roundStatus === "correct") return { label: "猜中", tone: "success" };
  if (player.roundStatus === "finished") return { label: "完成", tone: "default" };
  return null;
}
