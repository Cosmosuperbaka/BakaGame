import { AnimatePresence, motion } from "framer-motion";
import { spring, toastItem } from "@/lib/Motion";
import { cn } from "@/lib/Utils";

export interface ToastItem {
  id: string | number;
  text: string;
  type: "info" | "error" | "success";
}

export function ToastViewport({
  toasts,
}: {
  toasts: readonly ToastItem[];
}) {

  return (
    // 左右同时定位：窄屏长提示两侧留同样的边距；宽屏按内容收窄到 max-w-sm，由 ml-auto 靠右。
    // 外层是具名区域，读屏可以按地标跳到通知；每条提示自带播报语义：错误立即打断，其余排队读出。
    <div role="region" aria-label="通知" className="fixed inset-x-5 top-5 z-toast ml-auto flex w-fit max-w-sm flex-col gap-2 pointer-events-none">
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
            {...(t.type === "error" ? { role: "alert" } : { role: "status", "aria-live": "polite" as const })}
            // 外层取不透明的页面底色，状态浅底叠在内层：提示浮在任意内容之上，
            // 半透明底会让文字对比度随身后内容变化（盖在本人主色气泡上时几乎看不清）。
            className={cn(
              "pointer-events-auto overflow-hidden rounded-md border bg-background text-sm shadow-lg",
              t.type === "error" && "border-destructive/40",
              t.type === "success" && "border-success/40",
              t.type === "info" && "border-primary/40"
            )}
          >
            <div
              className={cn(
                "px-4 py-3",
                t.type === "error" && "bg-destructive/10 text-destructive",
                t.type === "success" && "bg-success/10 text-success",
                t.type === "info" && "bg-primary/10 text-primary"
              )}
            >
              {t.text}
            </div>
          </motion.div>
        ))}
      </AnimatePresence>
    </div>
  );
}
