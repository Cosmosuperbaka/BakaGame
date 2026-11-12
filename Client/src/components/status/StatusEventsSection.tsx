import { AnimatePresence, motion } from "framer-motion";
import type { PublicStatusEvent } from "@bakagame/shared";
import { CalendarClock, CircleCheck, CloudOff, TriangleAlert, Wrench } from "lucide-react";
import { Badge } from "@/components/ui/Badge";
import { popover } from "@/lib/Motion";
import { STATUS_COMPONENT_LABELS, STATUS_EVENT_STATUS_LABELS } from "@/lib/SystemStatus";
import { cn } from "@/lib/Utils";
import { DATETIME_FORMAT, DAY_FORMAT, TIME_FORMAT, isEventActive } from "./StatusFormat";

const affectedOf = (event: PublicStatusEvent): string =>
  event.components.map((component) => STATUS_COMPONENT_LABELS[component]).join("、") || "全站";

/** 事件卡的元信息：时间段与受影响组件，维护窗口带计划结束。 */
function EventMeta({ event }: { event: PublicStatusEvent }) {
  const range =
    event.kind === "maintenance"
      ? `${DATETIME_FORMAT.format(event.startedAt)} – ${
          event.plannedEndAt === null ? "待定" : TIME_FORMAT.format(event.plannedEndAt)
        }`
      : `${DATETIME_FORMAT.format(event.startedAt)} 起`;
  return (
    <p className="mt-2 flex flex-wrap items-center gap-x-2 gap-y-1 text-2xs text-muted-foreground">
      <span className="font-mono tabular-nums">{range}</span>
      {/* 间隔号取弱化前景色：描边色当字色在亮色下几乎看不见。 */}
      <span aria-hidden="true" className="text-muted-foreground/60">
        ·
      </span>
      <span className="truncate">{affectedOf(event)}</span>
    </p>
  );
}

function EventStatusBadge({ event }: { event: PublicStatusEvent }) {
  const active = isEventActive(event);
  return (
    <Badge
      variant={!active ? "subtle" : event.kind === "maintenance" ? "active" : "alert"}
      size="xs"
    >
      {STATUS_EVENT_STATUS_LABELS[event.status]}
    </Badge>
  );
}

function EventIcon({ event, className }: { event: PublicStatusEvent; className?: string }) {
  if (event.kind === "incident") {
    return (
      <TriangleAlert
        aria-hidden="true"
        // 进行中的故障固定用危险色，排在调用方类名之后：调用方给的弱化色不能把它盖掉。
        className={cn("shrink-0", className, isEventActive(event) && "text-destructive")}
      />
    );
  }
  const Icon = event.status === "scheduled" ? CalendarClock : Wrench;
  return <Icon aria-hidden="true" className={cn("shrink-0", className)} />;
}

/**
 * 事件与维护一览：进行中的成卡、带正文，已结束的收进一条时间线只留标题。
 * 两者都给足文字（状态徽章、时间、受影响组件），不只靠颜色；时间一律北京时间。
 * `events` 为 `undefined` 时仍在读取，为 `null` 时读失败——读失败不冒充「近一个月没有事件」。
 */
export function StatusEventsSection({
  events,
}: {
  events: PublicStatusEvent[] | null | undefined;
}) {
  const list = events ?? [];
  const active = list.filter(isEventActive);
  const past = list.filter((event) => !isEventActive(event));

  return (
    <section aria-labelledby="status-events" className="mt-10">
      <div className="flex items-baseline justify-between gap-3 px-1">
        <h2 id="status-events" className="text-sm font-semibold">
          事件与维护
        </h2>
        {events ? (
          <p className="text-2xs text-muted-foreground">
            {active.length > 0 ? `${active.length} 条进行中 · ` : ""}近 30 天
          </p>
        ) : null}
      </div>
      {events === undefined ? (
        <div
          aria-hidden="true"
          className="mt-2 h-14 motion-safe:animate-breathe rounded-md bg-muted"
        />
      ) : events === null ? (
        // 与下面「没有事件」同一种虚线框加前导图标：两种空状态只差图标与文案，不是一个有图标一个没有。
        <p className="mt-2 flex items-center gap-2 rounded-md border border-dashed p-4 text-sm text-muted-foreground">
          <CloudOff aria-hidden="true" className="size-4 shrink-0" />
          事件记录暂时读不到，稍后会自动重试。
        </p>
      ) : list.length === 0 ? (
        <p className="mt-2 flex items-center gap-2 rounded-md border border-dashed p-4 text-sm text-muted-foreground">
          <CircleCheck aria-hidden="true" className="size-4 shrink-0" />
          近一个月没有记录在案的事件或维护。
        </p>
      ) : (
        <div className="mt-2 space-y-2">
          <AnimatePresence initial={false}>
            {active.map((event) => (
              <motion.article
                key={event.id}
                layout
                variants={popover}
                initial="initial"
                animate="animate"
                exit="exit"
                className={cn(
                  "rounded-md border p-4 shadow-2xs",
                  event.kind === "incident"
                    ? "border-destructive/40 bg-destructive/10"
                    : "border-primary/30 bg-card"
                )}
              >
                <div className="flex min-w-0 items-center gap-2">
                  <EventIcon event={event} className="size-4 text-muted-foreground" />
                  <h3 className="min-w-0 flex-1 truncate text-sm font-semibold">{event.title}</h3>
                  <EventStatusBadge event={event} />
                </div>
                {event.body ? (
                  <p className="mt-1.5 text-sm leading-relaxed text-muted-foreground">
                    {event.body}
                  </p>
                ) : null}
                <EventMeta event={event} />
              </motion.article>
            ))}
          </AnimatePresence>
          {past.length > 0 ? (
            <ol className="divide-y divide-border rounded-md border bg-card shadow-2xs">
              {past.map((event) => (
                <li key={event.id} className="flex min-w-0 items-center gap-3 px-4 py-3">
                  <time
                    dateTime={new Date(event.startedAt).toISOString()}
                    className="w-16 shrink-0 font-mono text-xs tabular-nums text-muted-foreground"
                  >
                    {DAY_FORMAT.format(event.startedAt)}
                  </time>
                  <EventIcon event={event} className="size-3.5 text-muted-foreground" />
                  {/* 窄屏日期列、图标与状态徽章已占去大半行：标题换行完整显示，宽屏才单行截断。 */}
                  <span className="min-w-0 flex-1 text-sm break-words sm:truncate">{event.title}</span>
                  <span className="hidden max-w-40 shrink-0 truncate text-2xs text-muted-foreground sm:block">
                    {affectedOf(event)}
                  </span>
                  <EventStatusBadge event={event} />
                </li>
              ))}
            </ol>
          ) : null}
        </div>
      )}
      <p className="sr-only">
        时间均为北京时间。{active.length} 条进行中，{past.length} 条已结束。
      </p>
    </section>
  );
}
