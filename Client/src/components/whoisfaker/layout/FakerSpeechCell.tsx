import { Hint } from "@/components/ui/Tooltip";
import { PlayerAvatar } from "@/components/common/PlayerAvatar";
import {
  PLAYER_ME_MARK,
  PLAYER_ROW_BASE,
  PLAYER_ROW_HEIGHT,
} from "@/components/common/PlayerListLayout";
import { cn } from "@/lib/Utils";
import { FakerPendingSpeech, SubmittedSpeech } from "./FakerPendingSpeech";
import type { DescriptionRecord, PublicPlayerView } from "@bakagame/shared";

/**
 * 紧凑发言历史的玩家格：头像与名字，与完整玩家行同高，横滚时贴住左缘。
 * 出局只保留删除线与读屏文字，窄列里放不下次行的图标。
 */
export function CompactNameCell({ player, me }: { player: PublicPlayerView; me: boolean }) {
  const eliminated = player.roundStatus === "dead";
  return (
    <div className="sticky left-0 z-panel border-r bg-panel px-1.5">
      <div
        className={cn(
          PLAYER_ROW_BASE,
          PLAYER_ROW_HEIGHT,
          "pl-2 pr-1",
          me && "bg-primary/10",
          !player.online && !player.isBot && "opacity-60"
        )}
      >
        {me ? <span className={PLAYER_ME_MARK} /> : null}
        <PlayerAvatar name={player.name} me={me} />
        <Hint label={player.name}>
          <span
            className={cn(
              "min-w-0 truncate font-medium",
              eliminated && "text-muted-foreground line-through decoration-muted-foreground/60"
            )}
          >
            {player.name}
          </span>
        </Hint>
        {eliminated ? <span className="sr-only">已出局</span> : null}
      </div>
    </div>
  );
}

/**
 * 玩家行右侧的发言单元格。
 * 只有本列确实该发言的玩家才在未提交时显示等待占位；
 * 出题人、旁观者与本列无需发言的玩家留空。
 */
export function SpeechCell({
  description,
  expected,
  order,
  submitted,
  shade,
}: {
  description?: DescriptionRecord;
  expected: boolean;
  order?: number;
  /** 已提交但顺序未到，内容仍折起 */
  submitted?: boolean;
  /** 棋盘格底色，由所在行列的奇偶决定 */
  shade?: string;
}) {
  const orderBadge =
    order !== undefined ? (
      <span className="font-mono text-xs text-muted-foreground shrink-0 font-medium">#{order}</span>
    ) : null;
  return (
    <div
      className={cn(
        "flex items-center px-4 py-1.5 text-sm leading-relaxed",
        // 发言内容一律用正文色，列的种类由列标题表达，不靠正文变色区分。
        "text-foreground",
        shade
      )}
    >
      {/* 列宽已按本列最长发言取值，因此单行不再换行 */}
      {description ? (
        <span className="flex items-center gap-1.5 whitespace-nowrap">
          {orderBadge}
          <span>{description.text}</span>
        </span>
      ) : submitted ? (
        <div className="flex items-center gap-1.5">
          {orderBadge}
          <SubmittedSpeech />
        </div>
      ) : expected ? (
        <div className="flex items-center gap-1.5">
          {orderBadge}
          <FakerPendingSpeech />
        </div>
      ) : null}
    </div>
  );
}
