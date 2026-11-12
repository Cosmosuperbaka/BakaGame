import { AnimatePresence, motion } from "framer-motion";
import { CircleAlert, CircleCheck, Info, type LucideIcon } from "lucide-react";
import { spring, toastItem } from "@/lib/Motion";
import { cn } from "@/lib/Utils";

export interface ToastItem {
  id: string | number;
  text: string;
  type: "info" | "error" | "success";
}

/** 每种语义一枚前导图标：状态不只靠底色与字色区分（DesignGuide §3），色弱与灰度下也读得出成败。 */
const TOAST_ICONS: Record<ToastItem["type"], LucideIcon> = {
  info: Info,
  success: CircleCheck,
  error: CircleAlert,
};

export function ToastViewport({ toasts }: { toasts: readonly ToastItem[] }) {
  return (
    // 左右同时定位：窄屏长提示两侧留同样的边距；宽屏按内容收窄到 max-w-sm，由 ml-auto 靠右。
    // 外层是具名区域，读屏可以按地标跳到通知；每条提示自带播报语义：错误立即打断，其余排队读出。
    <div
      role="region"
      aria-label="通知"
      className="fixed inset-x-5 top-5 z-toast ml-auto flex w-fit max-w-sm flex-col gap-2 pointer-events-none"
    >
      <AnimatePresence initial={false}>
        {toasts.map((t) => (
          <motion.div
            key={t.id}
            layout
            variants={toastItem}
            initial="initial"
            animate="animate"
            exit="exit"
            transition={{ layout: spring.settle }}
            {...(t.type === "error"
              ? { role: "alert" }
              : { role: "status", "aria-live": "polite" as const })}
            // 外层取不透明的页面底色，状态浅底叠在内层：提示浮在任意内容之上，
            // 半透明底会让文字对比度随身后内容变化（盖在本人主色气泡上时几乎看不清）。
            className={cn(
              "pointer-events-auto overflow-hidden rounded-md border bg-background text-sm shadow-lg",
              t.type === "error" && "border-destructive/40",
              t.type === "success" && "border-success/40",
              t.type === "info" && "border-primary/40"
            )}
          >
            <ToastBody item={t} />
          </motion.div>
        ))}
      </AnimatePresence>
    </div>
  );
}

/** 提示正文：图标与首行文字居中对齐；正文用段落，窄屏折行走全局的 pretty 换行，末行不剩单字。 */
function ToastBody({ item }: { item: ToastItem }) {
  const Icon = TOAST_ICONS[item.type];
  return (
    <div
      className={cn(
        "flex items-start gap-2 px-4 py-3",
        item.type === "error" && "bg-destructive/10 text-destructive",
        item.type === "success" && "bg-success/10 text-success",
        item.type === "info" && "bg-primary/10 text-primary"
      )}
    >
      {/* 行高 1.25rem 的首行中线落在 0.625rem：图标 1rem 下移 0.125rem 与之对齐 */}
      <Icon className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
      <p className="min-w-0">{item.text}</p>
    </div>
  );
}
