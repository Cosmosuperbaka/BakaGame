import { PhaseStage } from "@/components/common/room/PhaseStage";
import { SongWaitingPhase } from "@/components/songuessr/phases/SongWaitingPhase";
import { SongRoundResultPhase } from "@/components/songuessr/phases/SongRoundResultPhase";
import { SongTestController } from "@/components/songuessr/layout/SongTestController";
import type { SongGameAreaProps } from "./SongGameAreaProps";
import { ChoosingSubmitterPhase } from "./SongChoosingSubmitterPhase";
import { SongPlayingPhase } from "./SongPlayingPhase";
import { SubmittingSongPhase } from "./SongSubmittingPhase";

export function GameStage(props: SongGameAreaProps) {
  const { snapshot, privateState, me, isHost, run, isPending } = props;

  if (snapshot.phase === "waiting") {
    return (
      <SongWaitingPhase
        snapshot={snapshot}
        me={me}
        isHost={isHost}
        submitterCandidateIds={privateState.submitterCandidateIds}
        run={run}
        isPending={isPending}
      />
    );
  }

  if (snapshot.phase === "choosingSubmitter") {
    return (
      <ChoosingSubmitterPhase
        snapshot={snapshot}
        privateState={privateState}
        isHost={isHost}
        run={run}
        isPending={isPending}
      />
    );
  }

  if (snapshot.phase === "submittingSong") {
    return <SubmittingSongPhase {...props} />;
  }

  if (snapshot.phase === "playing" && snapshot.currentRound) {
    return <SongPlayingPhase {...props} round={snapshot.currentRound} />;
  }

  if (snapshot.phase === "roundResult" && snapshot.roundSummary) {
    return (
      <SongRoundResultPhase
        snapshot={snapshot}
        privateState={privateState}
        me={me}
        isHost={isHost}
        run={run}
        isPending={isPending}
      />
    );
  }

  return (
    <SongWaitingPhase
      snapshot={snapshot}
      me={me}
      isHost={isHost}
      submitterCandidateIds={privateState.submitterCandidateIds}
      run={run}
      isPending={isPending}
    />
  );
}

export function SongGameArea(props: SongGameAreaProps) {
  return (
    <PhaseStage
      phaseKey={props.snapshot.phase}
      reserveBottom={props.snapshot.testMode}
      overlays={
        props.snapshot.testMode ? (
          <SongTestController
            run={props.run}
            snapshot={props.snapshot}
            isPending={props.isPending}
          />
        ) : null
      }
    >
      <GameStage {...props} />
    </PhaseStage>
  );
}
