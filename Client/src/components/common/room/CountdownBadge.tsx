import { Clock3 } from "lucide-react";
import { Badge } from "@/components/ui/Badge";
import { useSecondsLeft } from "@/hooks/UseSecondsLeft";

/** 剩余秒数不超过该值时转为警示色。 */
const URGENT_SECONDS = 10;

/**
 * 单次行动倒计时徽章；三个游戏的行动限时共用，末段转为警示色。
 * 传 deadlineAt 时自行按截止时间计时；调用方已算好秒数（猜歌房间页按自己的时钟计算）时直接传 secondsLeft。
 */
export function CountdownBadge(props: { deadlineAt: number } | { secondsLeft: number }) {
  const ticking = useSecondsLeft("deadlineAt" in props ? props.deadlineAt : null);
  const secondsLeft = "secondsLeft" in props ? props.secondsLeft : ticking;
  return (
    <Badge
      variant={secondsLeft <= URGENT_SECONDS ? "destructive" : "outline"}
      className="font-mono"
      role="timer"
      aria-label={`剩余 ${secondsLeft} 秒`}
    >
      <Clock3 className="h-3.5 w-3.5" aria-hidden="true" />
      {secondsLeft}s
    </Badge>
  );
}
