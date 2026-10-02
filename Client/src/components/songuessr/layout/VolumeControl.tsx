import { useState } from "react";
import { motion } from "framer-motion";
import * as Popover from "@radix-ui/react-popover";
import { Volume2 } from "lucide-react";
import { Button } from "@/components/ui/Button";
import { Slider } from "@/components/ui/Slider";
import { useCloseFrom } from "@/hooks/UseCloseFrom";
import { popover, readoutTick } from "@/lib/Motion";
import { cn } from "@/lib/Utils";

export interface VolumeControlProps {
  volume: number;
  onVolumeChange: (value: number) => void;
}

/**
 * 房间顶栏的播放音量。`sm` 起常驻为音量条；更窄时收成图标按钮、点开弹出滑块，
 * 把中栏让给轮数与视角徽章。
 */
export function VolumeControl({ volume, onVolumeChange }: VolumeControlProps) {
  const [open, setOpen] = useState(false);
  useCloseFrom(open, setOpen, "sm");
  const title = `播放音量 ${Math.round(volume * 100)}%`;

  return (
    <>
      <motion.div
        layout
        className="hidden items-center gap-2 rounded-md border border-border/70 bg-panel px-2.5 py-1.5 shadow-sm sm:flex"
        title={title}
      >
        <Volume2 className="h-4 w-4 shrink-0 text-muted-foreground" aria-hidden="true" />
        <VolumeSlider volume={volume} onVolumeChange={onVolumeChange} className="h-4 w-28" />
      </motion.div>
      <Popover.Root open={open} onOpenChange={setOpen}>
        <Popover.Trigger asChild>
          <Button type="button" variant="ghost" size="icon" className="sm:hidden" aria-label="调节音量" title={title}>
            <Volume2 className="h-5 w-5" />
          </Button>
        </Popover.Trigger>
        <Popover.Portal>
          <Popover.Content side="bottom" align="end" sideOffset={6} collisionPadding={12} aria-label="播放音量" asChild>
            <motion.div
              variants={popover}
              initial="initial"
              animate="animate"
              className="z-popover flex origin-(--radix-popover-content-transform-origin) items-center gap-2 floating-surface px-3 shadow-md"
            >
              <VolumeSlider volume={volume} onVolumeChange={onVolumeChange} className="h-9 w-36" />
            </motion.div>
          </Popover.Content>
        </Popover.Portal>
      </Popover.Root>
    </>
  );
}

/** 滑块与百分比读数，常驻音量条与弹出层共用；`className` 给出滑块所占的宽高。 */
function VolumeSlider({ volume, onVolumeChange, className }: VolumeControlProps & { className: string }) {
  const percentage = Math.round(volume * 100);
  return (
    <>
      <div className={cn("relative flex items-center", className)}>
        {/* 根节点撑满外层高度，整条都能按住拖动，不必对准细轨道。 */}
        <Slider className="h-full" value={[volume]} min={0} max={1} step={0.01} onValueChange={([val]) => onVolumeChange(val)} aria-label="播放音量" />
      </div>
      <motion.span
        key={percentage}
        {...readoutTick}
        className="min-w-10 text-right text-sm font-semibold tabular-nums text-foreground"
      >
        {percentage}%
      </motion.span>
    </>
  );
}
