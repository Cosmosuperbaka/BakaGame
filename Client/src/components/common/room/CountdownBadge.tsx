import { motion } from "framer-motion";
import { Clock3 } from "lucide-react";
import { Badge } from "@/components/ui/Badge";
import { useSecondsLeft } from "@/hooks/UseSecondsLeft";
import { readoutTick, urgentPulse } from "@/lib/Motion";

/** 剩余秒数不超过该值时转为警示色，图标开始脉动。 */
const URGENT_SECONDS = 10;

/** 读屏只在这几个节点播报一次，不逐秒打断。 */
const ANNOUNCE_AT = [10, 5, 0] as const;

/** 当前所处的播报节点：剩余秒数落到某个节点及以下，直到下一个节点之前都停在它上面，文字不变就不会重读。 */
const announcedMilestone = (secondsLeft: number) =>
  [...ANNOUNCE_AT].reverse().find((milestone) => secondsLeft <= milestone) ?? null;

/**
 * 单次行动倒计时徽章；三个游戏的行动限时共用，末段转为警示色、时钟图标脉动。
 * 传 deadlineAt 时自行按截止时间计时；调用方已算好秒数（猜歌房间页按自己的时钟计算）时直接传 secondsLeft。
 *
 * `timer` 角色默认不播报（aria-live off）：读屏停在徽章上时读到当前秒数，逐秒变化不打断；
 * 徽章旁另有一个视觉隐藏的 polite 区域，只在 10、5、0 秒节点各播报一次。
 */
export function CountdownBadge(props: { deadlineAt: number } | { secondsLeft: number }) {
  const ticking = useSecondsLeft("deadlineAt" in props ? props.deadlineAt : null);
  const secondsLeft = "secondsLeft" in props ? props.secondsLeft : ticking;
  const urgent = secondsLeft <= URGENT_SECONDS;
  const milestone = announcedMilestone(secondsLeft);
  return (
    <>
    <Badge variant={urgent ? "destructive" : "outline"} className="font-mono" role="timer">
      {/* 末段的脉动表达「快到时间了」这一持续状态；换 key 让脉动从头开始，回到常态时直接静止。 */}
      <motion.span
        key={urgent ? "urgent" : "calm"}
        className="flex"
        aria-hidden="true"
        {...(urgent ? urgentPulse : undefined)}
      >
        <Clock3 className="h-3.5 w-3.5" />
      </motion.span>
      {/* 每秒换一个节点，新值从贴近终值的位置顶上来，连续刷新不闪。 */}
      <motion.span
        key={secondsLeft}
        initial={readoutTick.initial}
        animate={readoutTick.animate}
        transition={readoutTick.transition}
        className="tabular-nums"
        aria-hidden="true"
      >
        {secondsLeft}s
      </motion.span>
      <span className="sr-only">剩余 {secondsLeft} 秒</span>
    </Badge>
    {/* 播报节点放在徽章外：读屏停在徽章上只读到当前秒数，不重复读出节点文案。sr-only 绝对定位，不占所在行的间距。 */}
    <span className="sr-only" aria-live="polite">{milestone === null ? "" : `剩余 ${milestone} 秒`}</span>
    </>
  );
}
