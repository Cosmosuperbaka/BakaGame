import { Volume2, VolumeX } from "lucide-react";
import { Button } from "@/components/ui/Button";
import { setSoundEnabled, useSoundEnabled } from "@/lib/SoundEffects";

/** 顶栏的音效开关：只控制本站的合成提示音，不接管猜歌播放器的音量。 */
export function SoundToggle() {
  const enabled = useSoundEnabled();
  return (
    <Button
      type="button"
      variant="ghost"
      size="icon"
      aria-label={enabled ? "音效：开" : "音效：关"}
      aria-pressed={enabled}
      onClick={() => setSoundEnabled(!enabled)}
    >
      {enabled ? <Volume2 aria-hidden="true" /> : <VolumeX aria-hidden="true" />}
    </Button>
  );
}
