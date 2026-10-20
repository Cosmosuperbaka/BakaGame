import { useId, useRef } from "react";
import { AnimatePresence, motion } from "framer-motion";
import { Users } from "lucide-react";
import { PlayerAvatar } from "@/components/common/PlayerAvatar";
import { SlidingIndicator } from "@/components/ui/SlidingIndicator";
import { Hint } from "@/components/ui/Tooltip";
import { useIndicatorRect } from "@/hooks/UseIndicatorRect";
import { listItem, tappable } from "@/lib/Motion";
import { TEAM_OPTIONS, teamKey, teamLabel } from "@/lib/Teams";
import { cn } from "@/lib/Utils";

const AVATAR_LIMIT = 2;

type TeamMember = { id: string; name: string; team: number | null };

const optionLabel = (team: number | null) => (team === null ? "个人游玩" : teamLabel(team));

/**
 * 等待页的队伍面板（CEE 与猜歌共用）：当前选择占满「我方」一整行，其余队伍以「对手」小格排在下方，
 * 个人游玩未选中时单独占一行，不再把个人与八支队伍平铺成同一张九宫格。
 * 所有选项仍是一个原生 radio 组：视觉顺序由 CSS `order` 决定，DOM 顺序保持队伍号递增，
 * 方向键切换与读屏语义不因换队重排而改变；选中底块仍由 `SlidingIndicator` 量出。
 * 只给参与者：`players` 由调用方筛成玩家组成员，旁观者没有队伍；`switching` 时整组禁用，不让连点发出交错的请求。
 */
export function TeamPicker({
  players,
  selfId,
  switching,
  hint,
  onPick,
}: {
  players: TeamMember[];
  selfId: string;
  switching: boolean;
  /** 标题右侧的一句规则说明 */
  hint: string;
  onPick: (team: number | null) => void;
}) {
  const gridRef = useRef<HTMLDivElement>(null);
  const titleId = useId();
  const groupName = useId();
  const current = players.find((player) => player.id === selfId)?.team ?? null;
  const rect = useIndicatorRect(gridRef, "[data-checked]", current);

  const members = new Map<number | null, TeamMember[]>(TEAM_OPTIONS.map((team) => [team, []]));
  for (const player of players) members.get(player.team)?.push(player);

  return (
    <section className="space-y-2">
      <div className="flex items-center justify-between gap-2">
        <h3 id={titleId} className="flex items-center gap-1.5 text-sm font-medium">
          <Users className="h-4 w-4 text-muted-foreground" aria-hidden="true" />
          选择队伍
        </h3>
        <span className="text-xs text-muted-foreground">{hint}</span>
      </div>
      <div
        ref={gridRef}
        role="radiogroup"
        aria-labelledby={titleId}
        aria-busy={switching || undefined}
        className="relative grid grid-cols-3 gap-1 rounded-md bg-muted p-1 sm:grid-cols-4"
      >
        <SlidingIndicator rect={rect} />
        <p className="col-span-3 px-1 font-sans text-2xs text-muted-foreground sm:col-span-4">
          我方
        </p>
        <p className="order-2 col-span-3 px-1 pt-1 font-sans text-2xs text-muted-foreground sm:col-span-4">
          对手
        </p>
        {TEAM_OPTIONS.map((team) => {
          const list = members.get(team) ?? [];
          const checked = team === current;
          const solo = team === null;
          return (
            <motion.label
              key={teamKey(team)}
              {...(switching ? undefined : tappable)}
              tabIndex={-1}
              data-checked={checked || undefined}
              className={cn(
                "group relative flex cursor-pointer rounded-md transition-colors",
                "has-focus-visible:outline-2 has-focus-visible:outline-ring",
                checked
                  ? "order-1 col-span-3 flex-col gap-1.5 px-2.5 py-2 sm:col-span-4"
                  : solo
                    ? "order-4 col-span-3 flex-row items-center justify-between gap-2 px-2.5 py-1.5 sm:col-span-4"
                    : "order-3 col-span-1 flex-col gap-1 px-2 py-1.5",
                checked ? "text-foreground" : "text-muted-foreground hover:text-foreground",
                switching && "cursor-wait"
              )}
            >
              <input
                type="radio"
                name={groupName}
                value={teamKey(team)}
                checked={checked}
                disabled={switching}
                onChange={() => onPick(team)}
                aria-label={`${teamLabel(team)}，${list.length} 人`}
                className="sr-only"
              />
              {checked ? (
                <SelectedTeam team={team} list={list} selfId={selfId} />
              ) : solo ? (
                <SoloOption list={list} selfId={selfId} />
              ) : (
                <TeamOption team={team} list={list} selfId={selfId} />
              )}
            </motion.label>
          );
        })}
      </div>
    </section>
  );
}

/** 我方大卡：队名、人数与全部队员名字；个人游玩说明不组队，不展示共享规则（规则在标题右侧）。 */
function SelectedTeam({
  team,
  list,
  selfId,
}: {
  team: number | null;
  list: TeamMember[];
  selfId: string;
}) {
  return (
    <>
      <span className="flex min-w-0 items-baseline justify-between gap-1.5">
        <span className="flex min-w-0 items-baseline gap-1.5">
          <span className="text-sm font-semibold">{optionLabel(team)}</span>
          <span className="font-sans text-2xs tabular-nums text-muted-foreground">
            {team === null ? "不组队" : `${list.length} 人`}
          </span>
        </span>
        <span className="shrink-0 font-sans text-2xs text-primary">已选</span>
      </span>
      {team === null ? (
        <span className="font-sans text-2xs text-muted-foreground">不加入队伍，独自作答</span>
      ) : list.length ? (
        <span className="flex flex-wrap items-center gap-x-2 gap-y-1">
          {list.map((player) => (
            <span
              key={player.id}
              className={cn(
                "flex min-w-0 items-center gap-1 text-xs",
                player.id === selfId && "text-primary"
              )}
            >
              <PlayerAvatar
                name={player.name}
                me={player.id === selfId}
                className="h-5 w-5 text-2xs"
              />
              <Hint label={player.name}>
                <span className="max-w-28 truncate">{player.name}</span>
              </Hint>
              {player.id === selfId ? (
                <span className="rounded bg-primary/10 px-1 font-sans text-2xs leading-none">
                  你
                </span>
              ) : null}
            </span>
          ))}
        </span>
      ) : (
        <span className="font-sans text-2xs text-muted-foreground">还没有人</span>
      )}
    </>
  );
}

/** 对手小格：队名、人数与最多两个队员头像；完整名单交给悬停。 */
function TeamOption({ team, list, selfId }: { team: number; list: TeamMember[]; selfId: string }) {
  return (
    <>
      <span className="relative flex items-baseline justify-between gap-1">
        <span className="text-sm font-medium">{teamLabel(team)}</span>
        <span className="font-sans text-2xs tabular-nums">
          {list.length ? `${list.length} 人` : "空"}
        </span>
      </span>
      <TeamMembers players={list} selfId={selfId} />
    </>
  );
}

/** 未选中个人游玩时单独占一行，与团队选项分开，不与对手挤在同一个格子里。 */
function SoloOption({ list, selfId }: { list: TeamMember[]; selfId: string }) {
  return (
    <>
      <span className="flex min-w-0 items-baseline gap-1.5">
        <span className="text-sm font-medium">个人游玩</span>
        <span className="font-sans text-2xs text-muted-foreground">不组队</span>
      </span>
      <span className="flex shrink-0 items-center gap-1.5">
        <TeamMembers players={list} selfId={selfId} />
        <span className="font-sans text-2xs tabular-nums">
          {list.length ? `${list.length} 人` : "空"}
        </span>
      </span>
    </>
  );
}

/**
 * 成员首字叠放，最多两个，其余折成「+N」；悬停提示列出全部名字。
 * 叠放处的描边取所在格子的底色（未选中是轨道的 muted，选中是底块的 background），读作一道缝而不是边框。
 */
function TeamMembers({ players, selfId }: { players: TeamMember[]; selfId: string }) {
  const shown = players.slice(0, AVATAR_LIMIT);
  const rest = players.length - shown.length;
  return (
    // 头像最多叠两个，余下只报数；全量名单交给悬停（对读屏隐藏，读屏读的是格子标题上的人数）
    <Hint label={players.map((player) => player.name).join("、") || undefined}>
      <span className="relative flex h-6 items-center" aria-hidden="true">
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
                index > 0 && "-ml-1.5"
              )}
            >
              <PlayerAvatar
                name={player.name}
                me={player.id === selfId}
                // 头像默认的 muted 底与轨道同色，换成与所在格子相反的那一档才看得出方块。
                className={cn(
                  "h-6 w-6 text-xs",
                  player.id !== selfId && "bg-background group-data-checked:bg-muted"
                )}
              />
            </motion.span>
          ))}
        </AnimatePresence>
        {rest > 0 ? <span className="ml-1 font-sans text-2xs tabular-nums">+{rest}</span> : null}
      </span>
    </Hint>
  );
}
