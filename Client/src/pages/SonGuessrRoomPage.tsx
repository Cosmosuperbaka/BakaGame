import { useCallback, useState } from "react";
import { Eye, Headphones, MessageSquare, Users } from "lucide-react";
import { Seo } from "@/components/common/Seo";
import { ChatPanel } from "@/components/common/ChatPanel";
import { ChatColumn, PlayerColumn, RoomShell } from "@/components/common/room/RoomShell";
import { HeaderChip, HeaderCounter } from "@/components/common/room/RoomHeader";
import { RoomJoinGate } from "@/components/common/room/RoomJoinGate";
import { RoomUtilityActions } from "@/components/common/room/RoomUtilityActions";
import { errorText } from "@/lib/ErrorMessage";
import { SongPlayerList } from "@/components/songuessr/SongPlayerList";
import { sendSongChoice } from "@/components/songuessr/SongSubmission";
import { SongVolumeControl } from "@/components/songuessr/layout/SongVolumeControl";
import { SongGameArea } from "@/components/songuessr/phases/SongGameStage";
import { useAudioClipPlayer } from "@/hooks/UseAudioClipPlayer";
import { useMinWidth } from "@/hooks/UseMinWidth";
import { useUnreadCount } from "@/hooks/UseUnreadCount";
import { usePageNavigate } from "@/hooks/UsePageTransition";
import { useSongRoom } from "@/components/songuessr/UseSongRoom";
import { songDisplayRound } from "@/lib/SonGuessrRound";
import type { SonGuessrRoomSnapshot } from "@bakagame/shared";
import { useSonGuessrStore } from "@/stores/UseSonGuessrStore";

/**
 * 播放器只关心「现在该播哪一段」：进行中取回合本身，结算取总结里的歌曲，
 * 其余阶段一律留空，播放器因此不会在换轮瞬间续播上一段。
 */
const pickPlayback = (
  snapshot: SonGuessrRoomSnapshot | null,
  phase: SonGuessrRoomSnapshot["phase"] | undefined
) => {
  if (phase === "playing") {
    const round = snapshot?.currentRound;
    return {
      currentPhaseRoundNumber: round?.roundNumber,
      currentAudioUrl: round?.audioUrl,
      currentClipStartTime: round?.lyricClip?.startTime,
      currentClipEndTime: round?.lyricClip?.endTime,
    };
  }
  if (phase === "roundResult") {
    const summary = snapshot?.roundSummary;
    return {
      currentPhaseRoundNumber: summary?.roundNumber,
      currentAudioUrl: summary?.song?.audioUrl,
      currentClipStartTime: summary?.song?.chorus?.startTime ?? 0,
      currentClipEndTime: summary?.song?.chorus?.endTime,
    };
  }
  return {
    currentPhaseRoundNumber: undefined,
    currentAudioUrl: undefined,
    currentClipStartTime: undefined,
    currentClipEndTime: undefined,
  };
};

export default function SonGuessrRoomPage({ solo = false }: { solo?: boolean }) {
  const navigate = usePageNavigate();
  const showToast = useSonGuessrStore((state) => state.showToast);
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
    passwordError,
    setPasswordDraft,
    confirmName,
    confirmPassword,
    runCommand,
    isPending,
    leave,
    sendCommand,
  } = useSongRoom({ solo });

  const isPlayingPhase = snapshot?.phase === "playing";
  const playback = pickPlayback(snapshot, snapshot?.phase);

  const { audioRef, volume, setVolume, audioStatus, audioPlaybackState, playAudio, retryAudio } =
    useAudioClipPlayer({
      roomId,
      phase: snapshot?.phase,
      ...playback,
      isPlayingPhase,
      sendCommand,
    });

  const [mobilePanel, setMobilePanel] = useState<"none" | "players" | "chat">("none");

  // 聊天在宽屏常驻、窄屏收进抽屉；抽屉关着时攒下的未读数挂在入口上。单人模式没有聊天。
  const chatDocked = useMinWidth("xl");
  const inRoom = Boolean(
    !solo &&
    !joining &&
    !needsName &&
    !needsPassword &&
    snapshot &&
    privateState &&
    snapshot.roomId === roomId
  );
  const unreadChat = useUnreadCount(inRoom ? (snapshot?.chat ?? []) : undefined, {
    open: chatDocked || mobilePanel === "chat",
    selfPlayerId: privateState?.playerId,
  });

  const handleSendChatMessage = useCallback(
    async (chatText: string) => {
      try {
        await sendCommand("song.chat.send", { text: chatText });
      } catch (error) {
        showToast(errorText(error, "发送失败，请重试"), "error");
        // 继续抛出：聊天面板要靠这次 reject 把原文收回输入框，吞掉就等于让玩家白打一遍
        throw error;
      }
    },
    [sendCommand, showToast]
  );

  // 严禁给这个 audio 加 crossOrigin：解灰音源（kuwo 等）不返回 Access-Control-Allow-Origin，
  // 一旦声明 crossOrigin="anonymous"，浏览器就会按 CORS 模式拉取媒体、直接判 net::ERR_FAILED，
  // 症状是「服务端解灰成功但客户端立刻 audioFailed」；官方歌曲的网易云 CDN 带 ACAO 所以看不出问题。
  // 全站没有任何 Web Audio / createMediaElementSource 用法，不需要该属性。
  // ref 必须是稳定对象：内联回调每次渲染换身份，React 会先摘后挂并重跑它，
  // 把淡入淡出中的音量重设成基础音量。初始音量由播放器 Hook 装载时负责。
  const audioNode = <audio ref={audioRef} className="hidden" preload="auto" playsInline />;

  const seoNode = (
    <Seo
      description={
        solo
          ? "Songuessr 单人模式，系统出题，自己和耳朵较劲。"
          : "这间 Songuessr 正在听歌猜题，进房一起抢答。"
      }
      path={solo ? "/songuessr/solo" : `/songuessr/room/${roomId}`}
      title={solo ? "听歌猜歌单人模式 - BakaGame" : "听歌猜歌房间 - BakaGame"}
      indexable={false}
    />
  );

  if (
    joining ||
    needsName ||
    needsPassword ||
    !snapshot ||
    !privateState ||
    snapshot.roomId !== roomId
  ) {
    return (
      <RoomJoinGate
        roomId={roomId}
        needsName={needsName}
        needsPassword={needsPassword}
        nameDraft={nameDraft}
        onNameDraftChange={setNameDraft}
        onConfirmName={() => void confirmName()}
        passwordDraft={passwordDraft}
        onPasswordDraftChange={setPasswordDraft}
        onConfirmPassword={() => void confirmPassword()}
        onExit={() => void navigate("/songuessr", { replace: true })}
        pending={joining}
        passwordError={passwordError}
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

  /** 桌面栏与窄屏抽屉各挂一份（按断点只挂其一），两处共用一个定义。 */
  const playerList = (
    <SongPlayerList
      players={snapshot.players}
      myPlayerId={privateState.playerId}
      isHost={isHost}
      phase={snapshot.phase}
      allowSpectators={snapshot.allowSpectators}
      questionType={snapshot.settings.questionType}
      maxGuesses={snapshot.settings.maxGuessesPerRound}
    />
  );
  const chatPanel = (
    <ChatPanel
      messages={snapshot.chat ?? []}
      players={snapshot.players}
      myPlayerId={privateState.playerId}
      onSendMessage={handleSendChatMessage}
      onRepeatMessage={handleSendChatMessage}
    />
  );

  return (
    <>
      <RoomShell
        before={
          <>
            {seoNode}
            {audioNode}
          </>
        }
        onLeave={() => void leave()}
        title={solo ? "单人模式" : snapshot.name}
        roomId={solo ? undefined : snapshot.roomId}
        center={
          <>
            {displayRound > 0 ? <HeaderCounter>第 {displayRound} 轮</HeaderCounter> : null}
            {privateState.isSubmitter ? <HeaderChip icon={Headphones} label="出题人" /> : null}
            {isSpectator || privateState.teamObserver ? (
              <HeaderChip icon={Eye} label="旁观" muted />
            ) : null}
          </>
        }
        actions={
          <>
            <SongVolumeControl volume={volume} onVolumeChange={setVolume} />
            <RoomUtilityActions agentsBlocked={snapshot.settings.allowAgents !== true} />
          </>
        }
        connectionIssue={connected ? null : "断线中..."}
        player={solo ? undefined : <PlayerColumn>{playerList}</PlayerColumn>}
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
            onSelectSearchSong={(songId, mode, extraId, clip, pick) =>
              sendSongChoice(sendCommand, {
                questionType: snapshot.settings.questionType,
                mode,
                id: songId,
                extraId,
                clip,
                pick,
              })
            }
            run={runCommand}
            isPending={isPending}
            audioRef={audioRef}
          />
        }
        chat={solo ? undefined : <ChatColumn>{chatPanel}</ChatColumn>}
        openDrawer={solo ? null : mobilePanel === "none" ? null : mobilePanel}
        onDrawerChange={(key) => setMobilePanel((key ?? "none") as "none" | "players" | "chat")}
        drawers={
          solo
            ? []
            : [
                {
                  key: "players",
                  icon: Users,
                  label: "玩家列表",
                  side: "left",
                  title: "玩家",
                  closeFrom: "md",
                  content: playerList,
                },
                {
                  key: "chat",
                  icon: MessageSquare,
                  label: "聊天",
                  side: "right",
                  title: "聊天",
                  closeFrom: "xl",
                  badge: unreadChat,
                  content: chatPanel,
                },
              ]
        }
      />
    </>
  );
}
