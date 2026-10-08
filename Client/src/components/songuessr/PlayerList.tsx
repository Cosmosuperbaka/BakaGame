import { useCallback, type ReactNode, type Ref } from "react";
import { AnimatePresence, motion } from "framer-motion";
import { ScrollArea } from "@/components/ui/ScrollArea";
import { PlayerRow, hostActions } from "@/components/common/PlayerRow";
import { PlayerGroupTitle, PlayerListLayout, PlayerStatusPill, type PlayerStatusTone } from "@/components/common/PlayerStatusPill";
import { SpectatorToggle } from "@/components/common/SpectatorToggle";
import { TeamSection } from "@/components/common/TeamSection";
import { usePlayerRowKeys } from "@/hooks/UsePlayerRowKeys";
import { listContainer } from "@/lib/Motion";
import { teamGroups } from "@/lib/Teams";
import { useSonGuessrStore } from "@/stores/UseSonGuessrStore";
import type { SonGuessrPhase, SonGuessrPlayerView, SongQuestionType } from "@/types";

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
  /** 本局题型：听歌识番时作答状态写「猜番」 */
  questionType?: SongQuestionType;
  /** 每局猜测次数上限：组队时队伍标题给出共享的已用次数 */
  maxGuesses?: number;
}

export function PlayerList({
  players,
  myPlayerId,
  isHost,
  phase,
  allowSpectators,
  questionType = "song",
  maxGuesses,
}: PlayerListProps) {
  const sendCommand = useSonGuessrStore((state) => state.sendCommand);
  const setNotice = useSonGuessrStore((state) => state.setNotice);
  const activePlayers = players.filter((player) => player.membership === "active");
  const observers = players.filter((player) => player.membership === "spectator");
  const groups = teamGroups(activePlayers);
  const teamed = groups.some((group) => group.team !== null);
  // 换组（含换队）后 key 随之变化，来回切换时不会复活还在退场的旧行（见 usePlayerRowKeys）。
  const rowKey = usePlayerRowKeys(players.map((player) => ({
    id: player.id,
    group: player.membership === "active" ? `active:${player.team ?? "solo"}` : player.membership,
  })));
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
      key={rowKey(player.id)}
      player={player}
      myPlayerId={myPlayerId}
      isHostViewer={isHost}
      phase={phase}
      questionType={questionType}
      hideSpectatorStatus={hideSpectatorStatus}
      onKick={handleKick}
      onTransferHost={handleTransferHost}
    />
  );

  const renderRows = (list: SonGuessrPlayerView[]) => (
    <motion.div
      className="flex flex-col gap-px"
      variants={listContainer(list.length)}
      initial={false}
      animate="animate"
    >
      <AnimatePresence initial={false} mode="popLayout">
        {list.map((player) => renderRow(player, false))}
      </AnimatePresence>
    </motion.div>
  );

  return (
    <ScrollArea className="h-full">
      <PlayerListLayout>
        <div className="min-w-0 px-2">
          <div className="relative flex min-w-0 w-full flex-col py-3">
            <PlayerGroupTitle label="玩家" count={activePlayers.length} />
            {teamed ? (
              // 有人组队时按队伍分块：队伍一块带标题与共享次数，个人游玩的人接在最后、不加底。
              <div className="flex flex-col gap-1.5">
                <AnimatePresence initial={false}>
                  {groups.map(({ team, members }) => (
                    <SongTeamSection key={team ?? "solo"} team={team} members={members} phase={phase} maxGuesses={maxGuesses}>
                      {renderRows(members)}
                    </SongTeamSection>
                  ))}
                </AnimatePresence>
              </div>
            ) : renderRows(activePlayers)}

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
                  <AnimatePresence initial={false} mode="popLayout">
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
      </PlayerListLayout>
    </ScrollArea>
  );
}

/**
 * 队伍块：同队共用一份猜测次数，作答中由标题给出一次「已用/上限」；出题人的队友本局观战，不计入。
 * 出题人自己不在任何队伍单元里，同样排除。
 */
function SongTeamSection({ ref, team, members, phase, maxGuesses, children }: {
  ref?: Ref<HTMLElement>;
  team: number | null;
  members: SonGuessrPlayerView[];
  phase: SonGuessrPhase;
  maxGuesses?: number;
  children: ReactNode;
}) {
  const guessing = members.filter((player) => player.roundStatus !== "observing" && player.roundStatus !== "submitter");
  const shared = phase === "playing" && maxGuesses !== undefined && guessing.length > 0
    && guessing.every((player) => player.guessesUsed === guessing[0]!.guessesUsed)
    ? guessing[0]!.guessesUsed : null;
  const detail = [`${members.length} 人`, shared !== null ? `${shared}/${maxGuesses} 次` : null].filter(Boolean).join(" · ");
  return (
    <TeamSection ref={ref} team={team} scores={members.map((player) => player.score)} detail={detail}>
      {children}
    </TeamSection>
  );
}

interface SongPlayerRowProps {
  ref?: Ref<HTMLDivElement>;
  player: SonGuessrPlayerView;
  myPlayerId?: string;
  isHostViewer: boolean;
  phase: SonGuessrPhase;
  questionType: SongQuestionType;
  hideSpectatorStatus: boolean;
  onKick: (playerId: string) => void;
  onTransferHost: (playerId: string) => void;
}

function SongPlayerRow({
  ref,
  player,
  myPlayerId,
  isHostViewer,
  phase,
  questionType,
  hideSpectatorStatus,
  onKick,
  onTransferHost,
}: SongPlayerRowProps) {
  const isMe = player.id === myPlayerId;
  const canManage = isHostViewer && !isMe;
  const canTransfer = canManage && player.membership === "active" && player.online && !player.isBot;
  const status = resolveSongStatus(player, phase, questionType, hideSpectatorStatus);
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
      layoutId={player.id}
      ref={ref}
    />
  );
}

function resolveSongStatus(
  player: SonGuessrPlayerView,
  phase: SonGuessrPhase,
  questionType: SongQuestionType,
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
  if (player.roundStatus === "guessing") return { label: questionType === "anime" ? "猜番" : "猜歌", tone: "warning" };
  if (player.roundStatus === "observing") return { label: "观战", tone: "default" };
  if (player.roundStatus === "correct") return { label: "猜中", tone: "success" };
  if (player.roundStatus === "teamCorrect") return { label: "队伍猜中", tone: "success" };
  if (player.roundStatus === "finished") return { label: "完成", tone: "default" };
  return null;
}
