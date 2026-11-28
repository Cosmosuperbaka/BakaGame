import * as SelectPrimitive from "@radix-ui/react-select";
import { motion } from "framer-motion";
import type { SongAudioQualityPreference } from "@bakagame/shared";
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectLabel,
  SelectSeparator,
} from "@/components/ui/Select";
import type { SongAudioQualityState } from "@/hooks/UseSongAudioQuality";
import { iconTappable } from "@/lib/motion/Feedback";
import {
  SPATIAL_QUALITY_OPTIONS,
  STEREO_QUALITY_OPTIONS,
  canDecodeQuality,
  qualityOption,
  type SongAudioQualityOption,
} from "@/lib/SongAudioQuality";
import { cn } from "@/lib/Utils";

export interface AudioQualityControlProps {
  quality: SongAudioQualityPreference;
  onQualityChange: (value: SongAudioQualityPreference) => void;
  /** 本回合实际放的是哪一档；缺省按「没有在放的歌」处理。 */
  qualityState?: SongAudioQualityState;
}

const nameOf = (value: SongAudioQualityPreference) => `「${qualityOption(value).label}」`;

/** 选单顶部那一句：这一回合实际在放什么、为什么不是选中的那一档。 */
function qualityStatusText(
  quality: SongAudioQualityPreference,
  state: SongAudioQualityState = { kind: "default" }
): string {
  switch (state.kind) {
    case "resolving":
      return `正在换到${nameOf(state.requested)}`;
    case "ready":
      return state.actual === state.requested
        ? `正在放${nameOf(state.actual)}`
        : `这首歌在本房最高到${nameOf(state.actual)}`;
    case "fallback":
      if (state.reason === "unsupported")
        return `这台设备解不了${nameOf(state.requested)}，正在放默认档`;
      if (state.reason === "unavailable")
        return `这首歌在本房拿不到${nameOf(state.requested)}，正在放默认档`;
      return `${nameOf(state.requested)}加载失败，正在放默认档`;
    default:
      return quality === "auto" ? "用出题时取好的默认档" : `下一首歌开始用${nameOf(quality)}`;
  }
}

/** 胶囊上那颗小字：显示正在放的档；换档途中显示要换去的档并压暗。 */
function chipOf(quality: SongAudioQualityPreference, state: SongAudioQualityState) {
  if (state.kind === "ready") return { value: state.actual, pending: false };
  if (state.kind === "resolving") return { value: state.requested, pending: true };
  if (state.kind === "fallback") return { value: "auto" as const, pending: false };
  return { value: quality, pending: false };
}

function QualityItem({ option }: { option: SongAudioQualityOption }) {
  const decodable = option.value === "auto" || canDecodeQuality(option.value);
  return (
    <SelectItem
      value={option.value}
      textValue={option.label}
      disabled={!decodable}
      hint={decodable ? option.spec : "此设备不支持"}
      className="py-1"
    >
      {option.label}
    </SelectItem>
  );
}

/**
 * 音量胶囊右端的音质选择：一颗写着当前档位的小字按钮，点开是按「立体声 / 空间音频」分组的选单。
 * 选中的是偏好，从下一次取地址起生效（回合中途换档会接着当前进度放）；实际在放哪一档写在选单顶部。
 * 档位名取两家平台都认得的叫法，本回合的歌来自哪个平台对猜题的人保密。
 */
export function SongAudioQualityMenu({
  quality,
  onQualityChange,
  qualityState = { kind: "default" },
}: AudioQualityControlProps) {
  const chip = chipOf(quality, qualityState);
  const chipLabel = qualityOption(chip.value).short;
  const status = qualityStatusText(quality, qualityState);

  return (
    <Select
      value={quality}
      onValueChange={(value) => onQualityChange(value as SongAudioQualityPreference)}
    >
      <SelectPrimitive.Trigger
        asChild
        aria-label={chip.pending ? `播放音质：正在换到${chipLabel}` : `播放音质：${chipLabel}`}
      >
        <motion.button
          type="button"
          {...iconTappable}
          aria-busy={chip.pending || undefined}
          className={cn(
            "flex h-7 shrink-0 items-center justify-center whitespace-nowrap rounded-full px-2 font-ui text-xs font-semibold transition-colors hover:bg-accent data-[state=open]:bg-accent",
            // 换档途中：压暗并呼吸，读作「还在路上」；读屏从 aria-label 里读到「正在换到」。
            chip.pending ? "text-muted-foreground motion-safe:animate-breathe" : "text-foreground"
          )}
        >
          {chipLabel}
        </motion.button>
      </SelectPrimitive.Trigger>
      {/* 十一档加分组标题放不进通用的 max-h-96：按视口里实际剩下的高度放，矮屏才滚动；
          顶部的状态不随选项滚走，回退的原因始终看得见。 */}
      <SelectContent
        side="bottom"
        align="end"
        sideOffset={6}
        className="max-h-(--radix-select-content-available-height) w-64"
        header={
          <div className="shrink-0 border-b px-3 pb-2 pt-2.5">
            <p className="text-sm font-semibold">播放音质</p>
            <p className="text-xs text-muted-foreground" aria-live="polite">
              {status}
            </p>
          </div>
        }
      >
        <SelectGroup>
          <SelectLabel>立体声</SelectLabel>
          {STEREO_QUALITY_OPTIONS.map((option) => (
            <QualityItem key={option.value} option={option} />
          ))}
        </SelectGroup>
        <SelectGroup>
          <SelectLabel>空间音频</SelectLabel>
          {SPATIAL_QUALITY_OPTIONS.map((option) => (
            <QualityItem key={option.value} option={option} />
          ))}
        </SelectGroup>
        <SelectSeparator />
        <p className="px-2 pb-1.5 pt-1 text-xs text-muted-foreground">
          档位越高，文件越大、加载越久。
        </p>
      </SelectContent>
    </Select>
  );
}
