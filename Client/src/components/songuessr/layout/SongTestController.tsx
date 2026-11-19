import { Bot } from "lucide-react";
import {
  BotCountRow,
  TestControlGroup,
  TestControllerShell,
} from "@/components/common/room/TestControllerShell";
import type { SonGuessrRoomSnapshot } from "@bakagame/shared";
import type { SongRunCommand } from "@/components/songuessr/UseSongRoom";

export interface SongTestControllerProps {
  snapshot: SonGuessrRoomSnapshot;
  run: SongRunCommand;
  isPending?: (type: string) => boolean;
}

export function SongTestController({ snapshot, run, isPending }: SongTestControllerProps) {
  const botCount = snapshot.players.filter((player) => player.isBot).length;

  return (
    <div className="pointer-events-none absolute bottom-3 left-3 right-3 z-drawer md:bottom-5 md:left-auto md:right-5">
      <div className="pointer-events-auto flex justify-end">
        <TestControllerShell title="测试控制器" bodyClassName="space-y-2 border-t px-4 pb-4 pt-3">
          <TestControlGroup label="测试人机" icon={Bot}>
            <BotCountRow
              count={botCount}
              addPending={isPending?.("song.test.addBot") ?? false}
              removePending={isPending?.("song.test.removeBot") ?? false}
              onAdd={() => void run("song.test.addBot", { count: 1 })}
              onRemove={() => void run("song.test.removeBot", { count: 1 })}
            />
          </TestControlGroup>
        </TestControllerShell>
      </div>
    </div>
  );
}
