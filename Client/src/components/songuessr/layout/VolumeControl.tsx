import { motion } from "framer-motion";
import { Volume2 } from "lucide-react";
import { spring } from "@/lib/Motion";

export interface VolumeControlProps {
  volume: number;
  onVolumeChange: (value: number) => void;
}

export function VolumeControl({
  volume,
  onVolumeChange,
}: VolumeControlProps) {
  const percentage = Math.round(volume * 100);
  return (
    <motion.div
      layout
      className="flex items-center gap-2 rounded-md border border-border/70 bg-panel px-2.5 py-1.5 shadow-sm"
      title={`播放音量 ${percentage}%`}
    >
      <Volume2 className="h-4 w-4 shrink-0 text-muted-foreground" aria-hidden="true" />
      <div className="relative h-4 w-20 sm:w-28">
        <div className="pointer-events-none absolute left-0 right-0 top-1/2 h-1.5 -translate-y-1/2 rounded-full bg-muted" />
        <motion.div
          aria-hidden="true"
          className="pointer-events-none absolute left-0 top-1/2 h-1.5 -translate-y-1/2 rounded-full bg-primary"
          animate={{ width: `${Math.max(0, Math.min(1, volume)) * 100}%` }}
          transition={spring.settle}
        />
        <motion.span
          aria-hidden="true"
          className="pointer-events-none absolute top-1/2 h-4 w-4 -translate-x-1/2 -translate-y-1/2 rounded-full border-2 border-background bg-primary shadow-sm"
          animate={{ left: `${Math.max(0, Math.min(1, volume)) * 100}%` }}
          transition={spring.settle}
        />
        <input
          type="range"
          min="0"
          max="1"
          step="0.01"
          value={volume}
          onChange={(event) => onVolumeChange(Number(event.target.value))}
          className="absolute inset-0 h-4 w-full cursor-pointer opacity-0"
          aria-label="播放音量"
        />
      </div>
      <motion.span
        key={percentage}
        initial={{ opacity: 0.5, y: 2, scale: 0.92 }}
        animate={{ opacity: 1, y: 0, scale: 1 }}
        transition={spring.snap}
        className="min-w-10 text-right text-sm font-semibold tabular-nums text-foreground"
      >
        {percentage}%
      </motion.span>
    </motion.div>
  );
}
