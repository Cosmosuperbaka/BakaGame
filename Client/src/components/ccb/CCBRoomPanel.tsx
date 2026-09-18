import { useEffect, type ReactNode } from "react";
import * as Drawer from "@radix-ui/react-dialog";
import { AnimatePresence, motion } from "framer-motion";
import { X } from "lucide-react";
import { Button } from "@/components/ui/Button";
import { spring, backdrop, duration, ease } from "@/lib/Motion";

export function CCBRoomPanel({ panel, title, onClose, children }: {
  panel: "players" | "chat" | null; title: string; onClose: () => void; children: ReactNode;
}) {
  useEffect(() => {
    if (!panel) return;
    const desktop = matchMedia(`(min-width: ${panel === "players" ? 768 : 1024}px)`);
    const closeDesktop = () => { if (desktop.matches) onClose(); };
    desktop.addEventListener("change", closeDesktop);
    return () => desktop.removeEventListener("change", closeDesktop);
  }, [panel, onClose]);
  return <Drawer.Root open={panel !== null} onOpenChange={(open) => { if (!open) onClose(); }}>
    <AnimatePresence>{panel ? <Drawer.Portal forceMount>
      <Drawer.Overlay forceMount asChild><motion.div variants={backdrop} initial="initial" animate="animate" exit="exit" className="fixed inset-0 z-overlay bg-foreground/20" /></Drawer.Overlay>
      <Drawer.Content forceMount asChild aria-describedby={undefined} aria-label={panel === "players" ? "玩家列表面板" : "聊天面板"}>
        <motion.aside initial={{ x: panel === "players" ? "-100%" : "100%" }} animate={{ x: 0, transition: spring.swift }} exit={{ x: panel === "players" ? "-100%" : "100%", transition: { duration: duration.quick, ease: ease.inOut } }} className={`fixed inset-y-0 z-modal flex max-w-full flex-col border bg-panel shadow-xl ${panel === "players" ? "left-0 w-72" : "right-0 w-80"}`}>
          <div className="flex items-center justify-between border-b px-3 py-1"><Drawer.Title className="text-sm">{title}</Drawer.Title><Drawer.Close asChild><Button variant="ghost" size="icon" aria-label="关闭面板"><X /></Button></Drawer.Close></div>
          <div className="min-h-0 flex-1">{children}</div>
        </motion.aside>
      </Drawer.Content>
    </Drawer.Portal> : null}</AnimatePresence>
  </Drawer.Root>;
}
