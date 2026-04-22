import { AnimatePresence, motion } from "framer-motion";
import { useGame } from "@/contexts/GameContext";
import { cn } from "@/lib/utils";

export function ToastContainer() {
  const { state } = useGame();

  return (
    <div className="fixed top-5 right-5 z-[100] flex flex-col gap-2 pointer-events-none max-w-sm">
      <AnimatePresence initial={false}>
        {state.toasts.map((t) => (
          <motion.div
            key={t.id}
            layout
            initial={{ opacity: 0, x: 24 }}
            animate={{ opacity: 1, x: 0 }}
            exit={{ opacity: 0, x: 24 }}
            transition={{ duration: 0.22, ease: [0.22, 1, 0.36, 1] }}
            className={cn(
              "pointer-events-auto rounded-lg px-4 py-3 text-sm shadow-md border backdrop-blur-sm",
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
