import { AnimatePresence, motion } from "framer-motion";
import { duration, ease, spring } from "@/lib/Motion";
import { useWhoIsFakerStore } from "@/stores/UseWhoIsFakerStore";
import { useSonGuessrStore } from "@/stores/UseSonGuessrStore";
import { useCCBStore } from "@/stores/UseCCBStore";
import { cn } from "@/lib/Utils";

export function ToastContainer() {
  const toasts = useWhoIsFakerStore((s) => s.toasts);

  return <ToastViewport toasts={toasts} />;
}

export function SonGuessrToastContainer() {
  const notice = useSonGuessrStore((state) => state.notice);
  const toasts = notice ? [{ id: `${notice.type}:${notice.text}`, ...notice }] : [];

  return <ToastViewport toasts={toasts} />;
}

export function CCBToastContainer() {
  const notice = useCCBStore((state) => state.notice);
  return <ToastViewport toasts={notice ? [{ id: `${notice.type}:${notice.text}`, ...notice }] : []} />;
}

function ToastViewport({
  toasts,
}: {
  toasts: Array<{ id: string | number; text: string; type: "info" | "error" | "success" }>;
}) {

  return (
    // 左右同时定位：窄屏长提示两侧留同样的边距；宽屏按内容收窄到 max-w-sm，由 ml-auto 靠右。
    <div className="fixed inset-x-5 top-5 z-toast ml-auto flex w-fit max-w-sm flex-col gap-2 pointer-events-none">
      <AnimatePresence initial={false}>
        {toasts.map((t) => (
          <motion.div
            key={t.id}
            layout
            initial={{ opacity: 0, x: 24, scale: 0.96 }}
            animate={{ opacity: 1, x: 0, scale: 1 }}
            exit={{
              opacity: 0,
              x: 24,
              scale: 0.97,
              transition: { duration: duration.quick, ease: ease.inOut },
            }}
            transition={{ ...spring.swift, layout: spring.settle }}
            className={cn(
              "pointer-events-auto rounded-md border px-4 py-3 text-sm shadow-md backdrop-blur-sm",
              t.type === "error" &&
                "bg-destructive/10 border-destructive/40 text-destructive",
              t.type === "success" &&
                "bg-success/10 border-success/40 text-success",
              t.type === "info" && "bg-primary/10 border-primary/25 text-primary"
            )}
          >
            {t.text}
          </motion.div>
        ))}
      </AnimatePresence>
    </div>
  );
}
