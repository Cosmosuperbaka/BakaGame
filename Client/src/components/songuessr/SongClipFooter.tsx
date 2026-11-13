import { ArrowLeft } from "lucide-react";
import { Button } from "@/components/ui/Button";
import { formatClipLength } from "./SongClipEditing";

/** 片段编辑器底部：错误提示、全房将听到的时长说明，以及返回与确认出题。 */
export function SongClipFooter({
  error,
  selectedLength,
  submitting,
  selectionValid,
  onCancel,
  onConfirm,
}: {
  error: string;
  selectedLength: number;
  submitting: boolean;
  selectionValid: boolean;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  return (
    <div className="border-t px-4 py-3 sm:px-5">
      {error ? (
        <p role="alert" className="mb-3 text-sm text-destructive">
          {error}
        </p>
      ) : null}
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <p className="text-center text-2xs leading-relaxed text-muted-foreground sm:max-w-xs sm:text-left">
          出题后，全房会听到这段 {formatClipLength(selectedLength)} 的音频。
        </p>
        <div className="flex flex-col-reverse gap-2 sm:flex-row">
          <Button
            type="button"
            variant="ghost"
            disabled={submitting}
            onClick={onCancel}
            data-agent-control="song.clip.cancel"
            className="text-muted-foreground hover:text-foreground"
          >
            <ArrowLeft aria-hidden="true" />
            返回重新选歌
          </Button>
          <Button
            type="button"
            className="sm:min-w-32"
            loading={submitting}
            disabled={!selectionValid || submitting}
            onClick={onConfirm}
            data-agent-control="song.clip.confirm"
          >
            用这段出题
          </Button>
        </div>
      </div>
    </div>
  );
}
