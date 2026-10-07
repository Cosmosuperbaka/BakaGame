import type { ReactNode } from "react";
import { Badge } from "@/components/ui/Badge";
import { ROLE_LABELS } from "@/config/WhoIsFakerPresentation";
import {
  REMOVAL_REASON_TEXT,
  groupHistoryByDay,
  historyEntryTitle,
  playerNameOf,
} from "@/lib/WhoIsFakerHistory";
import { cn } from "@/lib/Utils";
import { ABSTAIN_TARGET_ID, type PublicPlayerView, type RoundHistoryEntry } from "@/types";

/** 一条行为：谁、做了什么、对谁。 */
function ActionRow({ actor, verb, target, muted }: { actor: string; verb: string; target: ReactNode; muted?: boolean }) {
  return (
    <li className="flex min-w-0 items-center gap-2 rounded-md bg-background px-3 py-1.5 text-xs">
      <span className="min-w-0 truncate font-medium">{actor}</span>
      <span className="shrink-0 text-muted-foreground">{verb}</span>
      <span className={cn("min-w-0 truncate", muted ? "text-muted-foreground" : "font-medium")}>{target}</span>
    </li>
  );
}

/** 每个结算阶段的结论行：出局、平票或无事发生。 */
function Outcome({ names, empty, tieBreak }: { names: string[]; empty: string; tieBreak?: string[] }) {
  if (tieBreak?.length) {
    return <p className="text-xs"><span className="font-medium text-warning">{tieBreak.join("、")}</span><span className="text-muted-foreground"> 平票，进入 PK</span></p>;
  }
  if (!names.length) return <p className="text-xs text-muted-foreground">{empty}</p>;
  return <p className="text-xs"><span className="font-medium text-destructive">{names.join("、")}</span><span className="text-muted-foreground"> 出局</span></p>;
}

function EntryBody({ entry, players }: { entry: RoundHistoryEntry; players: PublicPlayerView[] }) {
  const nameOf = (id: string) => playerNameOf(players, id);
  switch (entry.kind) {
    case "vote":
      return (
        <>
          {entry.votes.length ? (
            <ul className="grid grid-cols-1 gap-1.5 md:grid-cols-2">
              {entry.votes.map((vote) => {
                const abstained = vote.targetId === ABSTAIN_TARGET_ID;
                return (
                  <ActionRow
                    key={vote.voterId}
                    actor={nameOf(vote.voterId)}
                    verb={abstained ? "选择" : "投给"}
                    target={abstained ? "弃票" : nameOf(vote.targetId)}
                    muted={abstained}
                  />
                );
              })}
            </ul>
          ) : null}
          <Outcome
            names={entry.eliminatedPlayerIds.map(nameOf)}
            empty={entry.votes.length ? "无人出局" : "无人投票，无人出局"}
            tieBreak={entry.tieBreakCandidateIds?.map(nameOf)}
          />
        </>
      );
    case "night":
      // 结算时才揭晓夜里谁动了手：阶段反馈只公布出局者
      return (
        <>
          {entry.actions.length ? (
            <ul className="grid grid-cols-1 gap-1.5 md:grid-cols-2">
              {entry.actions.map((action) => (
                <ActionRow
                  key={action.actorId}
                  actor={`${nameOf(action.actorId)}（${ROLE_LABELS[action.actorRole]}）`}
                  verb={action.targetId ? "刀了" : "选择"}
                  target={action.targetId ? nameOf(action.targetId) : "不行动"}
                  muted={!action.targetId}
                />
              ))}
            </ul>
          ) : null}
          <Outcome names={entry.eliminatedPlayerIds.map(nameOf)} empty="平安夜，无人出局" />
        </>
      );
    case "blankGuess":
      return (
        <div className="flex flex-wrap items-center gap-2 text-xs">
          <span className="font-medium">{nameOf(entry.playerId)}</span>
          <span className="text-muted-foreground">猜</span>
          <span className="font-medium">{entry.guessedWords[0] || "（空）"} / {entry.guessedWords[1] || "（空）"}</span>
          {/* 猜中是成功状态，取 matched；猜错取 destructive，两者都有文字 */}
          <Badge variant={entry.success ? "matched" : "destructive"} size="xs">
            {entry.success ? "猜中" : "未猜中"}
          </Badge>
          {entry.reviewed ? <span className="text-muted-foreground">经主持人裁定</span> : null}
        </div>
      );
    case "removal":
      return (
        <p className="text-xs">
          <span className="font-medium">{nameOf(entry.playerId)}</span>
          <span className="text-muted-foreground"> {REMOVAL_REASON_TEXT[entry.reason]}</span>
        </p>
      );
  }
}

/**
 * 结算页的全局历史：按时间顺序列出每个结算阶段里每个人的行为（描述阶段除外），
 * 夜晚的行动者与身份在这里才公开。
 */
export function RoundHistoryTimeline({ history, players }: { history: RoundHistoryEntry[]; players: PublicPlayerView[] }) {
  return (
    <div className="space-y-4 p-4">
      {groupHistoryByDay(history).map((group) => (
        <div key={group.day} className="space-y-2">
          <h4 className="text-xs font-semibold text-muted-foreground">第 {group.day} 天</h4>
          <ol className="space-y-3 border-l border-background pl-3">
            {group.entries.map((entry, index) => (
              <li key={`${entry.kind}-${entry.createdAt}-${index}`} className="space-y-1.5">
                <div className="text-xs font-semibold">{historyEntryTitle(entry)}</div>
                <EntryBody entry={entry} players={players} />
              </li>
            ))}
          </ol>
        </div>
      ))}
    </div>
  );
}
