import { AnimatePresence, motion } from "framer-motion";
import { duration, ease, spring } from "@/lib/Motion";
import { useWhoIsFakerStore } from "@/stores/UseWhoIsFakerStore";
import { useSonGuessrStore } from "@/stores/UseSonGuessrStore";
import { cn } from "@/lib/Utils";

export function ToastContainer() {
  const toasts = useWhoIsFakerStore((s) => s.toasts);

  return <ToastViewport toasts={toasts} />;
}

export function SongGuessrToastContainer() {
  const notice = useSonGuessrStore((state) => state.notice);
  const toasts = notice ? [{ id: `${notice.type}:${notice.text}`, ...notice }] : [];

  return <ToastViewport toasts={toasts} />;
}

function ToastViewport({
  toasts,
}: {
  toasts: Array<{ id: string | number; text: string; type: "info" | "error" | "success" }>;
}) {

  return (
    <div className="fixed top-5 right-5 z-[100] flex flex-col gap-2 pointer-events-none max-w-sm">
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
                "bg-destructive/10 border-destructive/30 text-destructive",
              t.type === "success" &&
                "bg-emerald-500/10 border-emerald-500/30 text-emerald-700",
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
