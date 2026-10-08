import { UserRound } from "lucide-react";
import type { CCBCharacterSummary, CCBSubjectSummary } from "@bakagame/shared";
import { useCCBStore } from "@/stores/UseCCBStore";
import { LazyImage } from "@/components/common/LazyImage";
import { cn } from "@/lib/Utils";

/** 角色图：列表里的方形缩略图，取方格图，避免竖版大图被裁到只剩头顶。 */
export function CCBCharacterImage({ character, className }: { character: CCBCharacterSummary; className?: string }) {
  return <LazyImage
    cacheKey={`ccb-character:${character.id}`}
    initial={character.imageUrl}
    className={cn("h-10 w-10", className)}
    imageClassName="object-top"
    fallback={<UserRound aria-hidden="true" />}
    request={async () => {
      const { imageUrl } = await useCCBStore.getState().sendCommand("ccb.character.image", { characterId: character.id, size: "grid" });
      return imageUrl;
    }}
  />;
}

/** 作品封面：竖版海报，与猜番搜索的番剧封面同尺寸；没有图时用 `fallback`（条目类型图标）。 */
export function CCBSubjectImage({ subject, className, fallback }: { subject: CCBSubjectSummary; className?: string; fallback: React.ReactNode }) {
  return <LazyImage
    cacheKey={`ccb-subject:${subject.id}`}
    initial={subject.imageUrl}
    className={cn("h-12 w-9", className)}
    fallback={fallback}
    request={async () => {
      const { imageUrl } = await useCCBStore.getState().sendCommand("ccb.subject.image", { subjectId: subject.id });
      return imageUrl;
    }}
  />;
}
