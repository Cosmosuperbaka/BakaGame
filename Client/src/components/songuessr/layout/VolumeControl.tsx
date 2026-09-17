import { motion } from "framer-motion";
import { Volume2 } from "lucide-react";
import { Slider } from "@/components/ui/Slider";
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
      <div className="relative flex items-center h-4 w-20 sm:w-28">
        <Slider
          value={[volume]}
          min={0}
          max={1}
          step={0.01}
          onValueChange={([val]) => onVolumeChange(val)}
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
