import { Bot } from "lucide-react";
import { BotCountRow, TestControllerShell } from "@/components/common/room/TestControllerShell";
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
        <TestControllerShell
          title="测试控制器"
          bodyClassName="space-y-2 border-t px-4 pb-4 pt-3"
          headerFocusInset={false}
        >
          {/* 与谁是卧底测试控制器的组标题同一口径：标题标签 + xs 半粗弱化色，图标随文字取弱化色。
              中性分组不按氛围上色，暗色下天蓝图标会成为浮层里唯一的冷色点。 */}
          <h3 className="flex items-center gap-1.5 text-xs font-semibold text-muted-foreground">
            <Bot className="h-3.5 w-3.5" aria-hidden="true" />
            测试人机
          </h3>
          <BotCountRow
            count={botCount}
            addPending={isPending?.("song.test.addBot") ?? false}
            removePending={isPending?.("song.test.removeBot") ?? false}
            onAdd={() => void run("song.test.addBot", { count: 1 })}
            onRemove={() => void run("song.test.removeBot", { count: 1 })}
          />
        </TestControllerShell>
      </div>
    </div>
  );
}
