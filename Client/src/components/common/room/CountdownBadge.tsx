import { Clock3 } from "lucide-react";
import { Badge } from "@/components/ui/Badge";
import { useSecondsLeft } from "@/hooks/UseSecondsLeft";

/** 剩余秒数不超过该值时转为警示色。 */
const URGENT_SECONDS = 10;

/** 单次行动倒计时徽章；三个游戏的行动限时共用，末段转为警示色。 */
export function CountdownBadge({ deadlineAt }: { deadlineAt: number }) {
  const secondsLeft = useSecondsLeft(deadlineAt);
  return (
    <Badge
      variant={secondsLeft <= URGENT_SECONDS ? "destructive" : "outline"}
      className="gap-1 font-mono"
      role="timer"
      aria-label={`剩余 ${secondsLeft} 秒`}
    >
      <Clock3 className="h-3.5 w-3.5" aria-hidden="true" />
      {secondsLeft}s
    </Badge>
  );
}
