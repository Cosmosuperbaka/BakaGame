/* eslint-disable react-refresh/only-export-components -- 行分组助手需要随容器一起被三个游戏消费，拆文件只会让调用点各写一遍。 */
import type { ReactNode } from "react";
import { AnimatePresence, motion } from "framer-motion";
import { listContainer } from "@/lib/motion/Choreography";
import { teamGroups } from "@/lib/Teams";

/**
 * 玩家/旁观分组的行容器：统一进出场编排（错峰入场、退场让位）。
 * 展开发言历史时列轨道由最外层 grid 持有，容器换成 subgrid 只负责纵向排布。
 */
export function PlayerRowGroup({
  count,
  layout = "list",
  children,
}: {
  count: number;
  layout?: "list" | "subgrid";
  children: ReactNode;
}) {
  return (
    <motion.div
      className={
        layout === "subgrid"
          ? "col-span-full grid grid-cols-subgrid gap-y-px"
          : "flex flex-col gap-px"
      }
      variants={listContainer(count)}
      initial={false}
      animate="animate"
    >
      <AnimatePresence initial={false} mode="popLayout">
        {children}
      </AnimatePresence>
    </motion.div>
  );
}

/** 有人组队时的队伍分块：队伍按队号升序、个人游玩接在最后；每块的标题与内容由调用方给出。 */
export function PlayerTeamBlocks<P extends { team: number | null }>({
  players,
  renderTeam,
}: {
  players: P[];
  renderTeam: (group: { team: number | null; members: P[] }) => ReactNode;
}) {
  return (
    <div className="flex flex-col gap-1">
      <AnimatePresence initial={false}>{teamGroups(players).map(renderTeam)}</AnimatePresence>
    </div>
  );
}

/** `usePlayerRowKeys` 的分组输入：参与者按队伍细分，其余按身份；换组（含换队）后行的 key 随之变化。 */
export function membershipRowGroups<
  P extends { id: string; membership: string; team: number | null },
>(players: P[]): Array<{ id: string; group: string }> {
  return players.map((player) => ({
    id: player.id,
    group: player.membership === "active" ? `active:${player.team ?? "solo"}` : player.membership,
  }));
}
