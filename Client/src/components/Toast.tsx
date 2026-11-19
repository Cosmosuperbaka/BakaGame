import { useEffect, useId, useState, type FocusEvent } from "react";
import { AnimatePresence, motion, useAnimationControls } from "framer-motion";
import { CircleAlert, CircleCheck, Info, type LucideIcon } from "lucide-react";
import { CloseButton } from "@/components/ui/CloseButton";
import { spring } from "@/lib/motion/Transitions";
import { toastItem } from "@/lib/motion/NamedMoves";
import { cn } from "@/lib/Utils";

export interface ToastItem {
  id: string | number;
  text: string;
  type: "info" | "error" | "success";
  /** 同一句话重发的次数：每加一次，这条提示原地重播入场并重新播报，不叠出第二条。 */
  repeat?: number;
}

interface ToastViewportProps {
  toasts: readonly ToastItem[];
  /** 玩家点了关闭钮：立即移除，不等计时。 */
  onDismiss: (id: ToastItem["id"]) => void;
  /** 指针停在提示上或焦点在提示里：停表，玩家读多久都行。 */
  onPause: (id: ToastItem["id"]) => void;
  /** 指针与焦点都离开了：按剩下的时长继续。 */
  onResume: (id: ToastItem["id"]) => void;
}

/** 每种语义一枚前导图标：状态不只靠底色与字色区分（DesignGuide §3），色弱与灰度下也读得出成败。 */
const TOAST_ICONS: Record<ToastItem["type"], LucideIcon> = {
  info: Info,
  success: CircleCheck,
  error: CircleAlert,
};

export function ToastViewport({ toasts, onDismiss, onPause, onResume }: ToastViewportProps) {
  return (
    // 左右同时定位：窄屏长提示两侧留同样的边距；宽屏按内容收窄到 max-w-sm，由 ml-auto 靠右。
    // 外层是具名区域，读屏可以按地标跳到通知；每条提示自带播报语义：错误立即打断，其余排队读出。
    // 容器不接指针事件，只有提示条本身接：关闭钮与悬停暂停不挡住提示之间与周围的页面操作。
    <div
      role="region"
      aria-label="通知"
      className="fixed inset-x-5 top-5 z-toast ml-auto flex w-fit max-w-sm flex-col gap-2 pointer-events-none"
    >
      <AnimatePresence initial={false}>
        {toasts.map((t) => (
          <ToastCard
            key={t.id}
            item={t}
            onDismiss={onDismiss}
            onPause={onPause}
            onResume={onResume}
          />
        ))}
      </AnimatePresence>
    </div>
  );
}

type ToastCardProps = Omit<ToastViewportProps, "toasts"> & { item: ToastItem };

function ToastCard({ item, onDismiss, onPause, onResume }: ToastCardProps) {
  const controls = useAnimationControls();
  const repeat = item.repeat ?? 0;
  const textId = useId();
  // 悬停与聚焦分开记：鼠标移开但焦点还在关闭钮上（或反过来）时仍算在看。
  const [hovered, setHovered] = useState(false);
  const [focused, setFocused] = useState(false);
  const held = hovered || focused;
  const { id } = item;
  useEffect(() => {
    if (held) onPause(id);
    else onResume(id);
  }, [held, id, onPause, onResume]);
  // 首次挂载播入场；同一句话重发时从入场起点再播一遍，读作「又来了一次」，而不是另起一条。
  useEffect(() => {
    if (repeat > 0) controls.set("initial");
    void controls.start("animate");
  }, [controls, repeat]);
  const leaveFocus = (event: FocusEvent<HTMLDivElement>) => {
    if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setFocused(false);
  };
  return (
    <motion.div
      layout
      variants={toastItem}
      initial="initial"
      animate={controls}
      exit="exit"
      transition={{ layout: spring.settle }}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      onFocus={() => setFocused(true)}
      onBlur={leaveFocus}
      // 外层取不透明的页面底色，状态浅底叠在内层：提示浮在任意内容之上，
      // 半透明底会让文字对比度随身后内容变化（盖在本人主色气泡上时几乎看不清）。
      className={cn(
        "pointer-events-auto overflow-hidden rounded-md border bg-background text-sm shadow-lg",
        item.type === "error" && "border-destructive/40",
        item.type === "success" && "border-success/40",
        item.type === "info" && "border-primary/40"
      )}
    >
      <div
        className={cn(
          "flex items-start gap-2 py-3 pl-4 pr-2",
          item.type === "error" && "bg-destructive/10 text-destructive",
          item.type === "success" && "bg-success/10 text-success",
          item.type === "info" && "bg-primary/10 text-primary"
        )}
      >
        {/* 播报节点按重发次数换新：内容不变的节点读屏不会再读，换一个新节点才会。 */}
        <ToastBody key={repeat} item={item} textId={textId} />
        {/* 关闭钮在播报节点之外：读屏播报只读提示文字。上下各收 0.25rem，与首行文字居中且不撑高单行提示。 */}
        <CloseButton
          aria-label="关闭通知"
          aria-describedby={textId}
          className="-my-1 h-7 w-7"
          onClick={() => onDismiss(id)}
        />
      </div>
    </motion.div>
  );
}

/** 提示正文：图标与首行文字居中对齐；正文用段落，窄屏折行走全局的 pretty 换行，末行不剩单字。 */
function ToastBody({ item, textId }: { item: ToastItem; textId: string }) {
  const Icon = TOAST_ICONS[item.type];
  return (
    <div
      {...(item.type === "error"
        ? { role: "alert" }
        : { role: "status", "aria-live": "polite" as const })}
      className="flex min-w-0 flex-1 items-start gap-2"
    >
      {/* 行高 1.25rem 的首行中线落在 0.625rem：图标 1rem 下移 0.125rem 与之对齐 */}
      <Icon className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
      <p id={textId} className="min-w-0">
        {item.text}
      </p>
    </div>
  );
}
