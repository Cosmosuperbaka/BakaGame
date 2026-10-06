import { useId, useRef } from "react";
import { AnimatePresence, motion } from "framer-motion";
import { Users } from "lucide-react";
import type { CCBPlayer, CCBPrivateState, CCBRoomSnapshot } from "@bakagame/shared";
import { PlayerAvatar } from "@/components/common/PlayerAvatar";
import { SlidingIndicator } from "@/components/ui/SlidingIndicator";
import { useIndicatorRect } from "@/hooks/UseIndicatorRect";
import { useCCBAction } from "@/hooks/UseCCBAction";
import { listItem, tappable } from "@/lib/Motion";
import { cn } from "@/lib/Utils";

/** 协议允许的队伍号 1–8，与 `ccb.player.team` 的取值一致；null 是个人游玩。 */
const TEAMS: Array<number | null> = [null, 1, 2, 3, 4, 5, 6, 7, 8];
const AVATAR_LIMIT = 4;

const teamKey = (team: number | null) => (team === null ? "solo" : String(team));
const teamLabel = (team: number | null) => (team === null ? "个人" : `${team} 队`);

/**
 * 等待页的队伍面板：个人与 1–8 队排成三列九格，每格写明人数并叠放成员首字，点一格即加入。
 * 基于原生 radio，方向键切换与读屏语义由浏览器提供；选中底块与分段控件同一个 `SlidingIndicator`，在格子之间滑过去。
 * 只给参与者，旁观者没有队伍；切换命令执行中整组禁用，不让连点发出交错的请求。
 */
export function CCBTeamPicker({ snapshot, privateState }: { snapshot: CCBRoomSnapshot; privateState: CCBPrivateState }) {
  const me = snapshot.players.find((player) => player.id === privateState.playerId);
  const { run, pending } = useCCBAction();
  const gridRef = useRef<HTMLDivElement>(null);
  const titleId = useId();
  const groupName = useId();
  const current = me?.team ?? null;
  const rect = useIndicatorRect(gridRef, "[data-checked]", current);
  if (!me || me.membership !== "active") return null;

  const members = new Map<number | null, CCBPlayer[]>(TEAMS.map((team) => [team, []]));
  for (const player of snapshot.players) {
    if (player.membership === "active") members.get(player.team)?.push(player);
  }
  const switching = pending.has("ccb.player.team");

  return (
    <section className="space-y-2">
      <div className="flex items-center justify-between gap-2">
        <h3 id={titleId} className="flex items-center gap-1.5 text-sm font-medium">
          <Users className="h-4 w-4 text-muted-foreground" aria-hidden="true" />
          选择队伍
        </h3>
        <span className="text-xs text-muted-foreground">同队共享次数与猜测</span>
      </div>
      <div
        ref={gridRef}
        role="radiogroup"
        aria-labelledby={titleId}
        aria-busy={switching || undefined}
        className="relative grid grid-cols-3 gap-1 rounded-md bg-muted p-1"
      >
        <SlidingIndicator rect={rect} />
        {TEAMS.map((team) => {
          const list = members.get(team) ?? [];
          const checked = team === current;
          return (
            <motion.label
              key={teamKey(team)}
              {...(switching ? undefined : tappable)}
              tabIndex={-1}
              data-checked={checked || undefined}
              className={cn(
                "group relative flex cursor-pointer flex-col gap-1 rounded-md px-2.5 py-1.5 transition-colors",
                "has-focus-visible:outline-2 has-focus-visible:outline-ring",
                checked ? "text-foreground" : "text-muted-foreground hover:bg-background/40 hover:text-foreground",
                switching && "cursor-wait",
              )}
            >
              <input
                type="radio"
                name={groupName}
                value={teamKey(team)}
                checked={checked}
                disabled={switching}
                onChange={() => void run("ccb.player.team", { team })}
                aria-label={`${teamLabel(team)}，${list.length} 人`}
                className="sr-only"
              />
              <span className="relative flex items-baseline justify-between gap-1">
                <span className="text-sm font-medium">{teamLabel(team)}</span>
                <span className="font-sans text-2xs tabular-nums">{list.length ? `${list.length} 人` : "空"}</span>
              </span>
              <TeamMembers players={list} selfId={me.id} />
            </motion.label>
          );
        })}
      </div>
    </section>
  );
}

/**
 * 成员首字叠放，最多四个，其余折成「+N」；悬停提示列出全部名字。
 * 叠放处的描边取所在格子的底色（未选中是轨道的 muted，选中是底块的 background），读作一道缝而不是边框。
 */
function TeamMembers({ players, selfId }: { players: CCBPlayer[]; selfId: string }) {
  const shown = players.slice(0, AVATAR_LIMIT);
  const rest = players.length - shown.length;
  return (
    <span className="relative flex h-6 items-center" title={players.map((player) => player.name).join("、") || undefined} aria-hidden="true">
      <AnimatePresence initial={false}>
        {shown.map((player, index) => (
          <motion.span
            key={player.id}
            variants={listItem}
            initial="initial"
            animate="animate"
            exit="exit"
            layout="position"
            className={cn(
              "rounded-md ring-2 ring-muted group-data-checked:ring-background dark:group-data-checked:ring-secondary",
              index > 0 && "-ml-1.5",
            )}
          >
            <PlayerAvatar
              name={player.name}
              me={player.id === selfId}
              // 头像默认的 muted 底与轨道同色，换成与所在格子相反的那一档才看得出方块。
              className={cn("h-6 w-6 text-xs", player.id !== selfId && "bg-background group-data-checked:bg-muted")}
            />
          </motion.span>
        ))}
      </AnimatePresence>
      {rest > 0 ? <span className="ml-1 font-sans text-2xs tabular-nums">+{rest}</span> : null}
    </span>
  );
}
