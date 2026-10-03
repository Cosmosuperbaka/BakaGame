import { useCallback, useState } from "react";
import {
  Eye,
  Headphones,
  Menu,
  MessageSquare,
} from "lucide-react";
import { Seo } from "@/components/common/Seo";
import { ChatPanel } from "@/components/common/ChatPanel";
import { ChatColumn, PlayerColumn, RoomShell } from "@/components/common/room/RoomShell";
import { HeaderChip, HeaderCounter } from "@/components/common/room/RoomHeader";
import { RoomJoinGate } from "@/components/common/room/RoomJoinGate";
import { PlayerList } from "@/components/songuessr/PlayerList";
import { VolumeControl } from "@/components/songuessr/layout/VolumeControl";
import { SongGameArea } from "@/components/songuessr/phases/SongGameStage";
import { useAudioClipPlayer } from "@/hooks/UseAudioClipPlayer";
import { usePageNavigate } from "@/hooks/UsePageTransition";
import { useSongRoomLifecycle } from "@/hooks/UseSongRoomLifecycle";
import { songDisplayRound } from "@/lib/SonGuessrRound";
import { useSonGuessrStore } from "@/stores/UseSonGuessrStore";

export default function SonGuessrRoomPage({ solo = false }: { solo?: boolean }) {
  const navigate = usePageNavigate();
  const setNotice = useSonGuessrStore((state) => state.setNotice);
  const connected = useSonGuessrStore((state) => state.connected);

  const {
    roomId,
    snapshot,
    privateState,
    joining,
    needsName,
    nameDraft,
    setNameDraft,
    needsPassword,
    passwordDraft,
    setPasswordDraft,
    handleConfirmName,
    handleConfirmPassword,
    runCommand,
    isPending,
    leave,
    sendCommand,
  } = useSongRoomLifecycle({ solo });

  const isPlayingPhase = snapshot?.phase === "playing";
  const isRoundResultPhase = snapshot?.phase === "roundResult";
  const round = snapshot?.currentRound;
  const roundSummary = snapshot?.roundSummary;

  const currentPhaseRoundNumber = isPlayingPhase
    ? round?.roundNumber
    : isRoundResultPhase
      ? roundSummary?.roundNumber
      : undefined;

  const currentAudioUrl = isPlayingPhase
    ? round?.audioUrl
    : isRoundResultPhase
      ? roundSummary?.song?.audioUrl
      : undefined;

  const currentClipStartTime = isPlayingPhase
    ? round?.lyricClip?.startTime
    : isRoundResultPhase
      ? (roundSummary?.song?.chorus?.startTime ?? 0)
      : undefined;

  const currentClipEndTime = isPlayingPhase
    ? round?.lyricClip?.endTime
    : isRoundResultPhase
      ? roundSummary?.song?.chorus?.endTime
      : undefined;

  const {
    audioRef,
    volume,
    setVolume,
    audioStatus,
    audioPlaybackState,
    playAudio,
    retryAudio,
  } = useAudioClipPlayer({
    roomId,
    phase: snapshot?.phase,
    currentPhaseRoundNumber,
    currentAudioUrl,
    currentClipStartTime,
    currentClipEndTime,
    isPlayingPhase,
    sendCommand,
  });

  const [searchMode, setSearchMode] = useState<"submit" | "guess" | null>(null);
  const [mobilePanel, setMobilePanel] = useState<"none" | "players" | "chat">("none");

  const handleSendChatMessage = useCallback(
    async (chatText: string) => {
      try {
        await sendCommand("song.chat.send", { text: chatText });
      } catch (error) {
        setNotice((error as { message: string }).message, "error");
      }
    },
    [sendCommand, setNotice],
  );

  // 严禁给这个 audio 加 crossOrigin：解灰音源（kuwo 等）不返回 Access-Control-Allow-Origin，
  // 一旦声明 crossOrigin="anonymous"，浏览器就会按 CORS 模式拉取媒体、直接判 net::ERR_FAILED，
  // 症状是「服务端解灰成功但客户端立刻 audioFailed」；官方歌曲的网易云 CDN 带 ACAO 所以看不出问题。
  // 全站没有任何 Web Audio / createMediaElementSource 用法，不需要该属性。
  const audioNode = (
    <audio
      ref={(node) => {
        audioRef.current = node;
        if (node) node.volume = volume;
      }}
      className="hidden"
      preload="auto"
      playsInline
    />
  );

  const seoNode = (
    <Seo
      description={solo ? "Songuessr 音乐与番剧单人挑战中，冲击更高连胜纪录！" : "Songuessr 音乐与番剧竞猜激战中，点击立即上车听前奏抢答！"}
      path={solo ? "/songuessr/solo" : `/songuessr/room/${roomId}`}
      indexable={false}
    />
  );

  if (joining || needsName || needsPassword || !snapshot || !privateState || snapshot.roomId !== roomId) {
    return (
      <RoomJoinGate
        roomId={roomId}
        needsName={needsName}
        needsPassword={needsPassword}
        nameDraft={nameDraft}
        onNameDraftChange={setNameDraft}
        onConfirmName={() => void handleConfirmName()}
        passwordDraft={passwordDraft}
        onPasswordDraftChange={setPasswordDraft}
        onConfirmPassword={() => void handleConfirmPassword()}
        onExit={() => navigate("/songuessr", { replace: true })}
      >
        {seoNode}
        {audioNode}
      </RoomJoinGate>
    );
  }

  const me = snapshot.players.find((player) => player.id === privateState.playerId);
  const isHost = snapshot.hostPlayerId === privateState.playerId;
  const isSpectator = me?.membership === "spectator";
  const displayRound = songDisplayRound(snapshot.phase, snapshot.roundNumber);

  return (
    <>
      <RoomShell
        before={<>{seoNode}{audioNode}</>}
        onLeave={() => void leave()}
        title={solo ? "单人模式" : snapshot.name}
        roomId={solo ? undefined : snapshot.roomId}
        center={<>
          {displayRound > 0 ? <HeaderCounter>第 {displayRound} 轮</HeaderCounter> : null}
          {privateState.isSubmitter ? <HeaderChip icon={Headphones} label="出题人" /> : null}
          {isSpectator ? <HeaderChip icon={Eye} label="旁观" muted /> : null}
        </>}
        actions={<VolumeControl volume={volume} onVolumeChange={setVolume} />}
        connectionIssue={connected ? null : "断线中..."}
        player={solo ? undefined : (
          <PlayerColumn>
            <div className="min-h-0 min-w-0 flex-1 overflow-hidden rounded-md">
              <PlayerList
                players={snapshot.players}
                myPlayerId={privateState.playerId}
                isHost={isHost}
                phase={snapshot.phase}
                allowSpectators={snapshot.allowSpectators}
              />
            </div>
          </PlayerColumn>
        )}
        game={
          <SongGameArea
            snapshot={snapshot}
            privateState={privateState}
            me={me}
            isHost={isHost}
            guessDeadlineAt={privateState.guessDeadlineAt}
            volume={volume}
            onVolumeChange={setVolume}
            audioStatus={audioStatus}
            audioPlaybackState={audioPlaybackState}
            onPlayAudio={() => void playAudio()}
            onRetryAudio={retryAudio}
            openSearch={setSearchMode}
            searchMode={searchMode}
            closeSearch={() => setSearchMode(null)}
            onSelectSearchSong={async (songId, mode) => {
              if (snapshot.settings.questionType === "anime") {
                await sendCommand(mode === "submit" ? "song.game.submitAnime" : "song.game.guessAnime", { subjectId: songId });
              } else {
                await sendCommand(mode === "submit" ? "song.game.submitSong" : "song.game.guess", { songId });
              }
            }}
            run={runCommand}
            isPending={isPending}
            audioRef={audioRef}
          />
        }
        chat={solo ? undefined : (
          <ChatColumn>
            <ChatPanel
              messages={snapshot.chat ?? []}
              players={snapshot.players}
              myPlayerId={privateState.playerId}
              onSendMessage={handleSendChatMessage}
            />
          </ChatColumn>
        )}
        openDrawer={solo ? null : mobilePanel === "none" ? null : mobilePanel}
        onDrawerChange={(key) => setMobilePanel((key ?? "none") as "none" | "players" | "chat")}
        drawers={solo ? [] : [
          {
            key: "players",
            icon: Menu,
            label: "玩家列表",
            side: "left",
            title: "玩家",
            closeFrom: "md",
            content: (
              <PlayerList
                players={snapshot.players}
                myPlayerId={privateState.playerId}
                isHost={isHost}
                phase={snapshot.phase}
                allowSpectators={snapshot.allowSpectators}
              />
            ),
          },
          {
            key: "chat",
            icon: MessageSquare,
            label: "聊天",
            side: "right",
            title: "聊天",
            closeFrom: "xl",
            content: (
              <ChatPanel
                messages={snapshot.chat ?? []}
                players={snapshot.players}
                myPlayerId={privateState.playerId}
                onSendMessage={handleSendChatMessage}
              />
            ),
          },
        ]}
      />
    </>
  );
}
