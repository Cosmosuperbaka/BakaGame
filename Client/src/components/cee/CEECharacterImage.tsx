import { UserRound } from "lucide-react";
import type { CEECharacterSummary, CEEImageSize, CEESubjectSummary } from "@bakagame/shared";
import { LazyImage } from "@/components/common/LazyImage";
import { useCEEDataSource } from "@/lib/CEEDataSource";
import { cn } from "@/lib/Utils";

/**
 * 角色图。两档尺寸：列表的方形框用 `grid`（竖版大图会被裁到只剩头顶）；
 * 答案卡那种竖版大框用 `large`。
 *
 * 列表带下来的 `imageUrl` 是方格图，取 `large` 时先拿它顶着、同时把大图要回来，
 * 中间不闪占位图标。
 */
export function CEECharacterImage({
  character,
  className,
  size = "grid",
}: {
  character: CEECharacterSummary;
  className?: string;
  size?: CEEImageSize;
}) {
  const source = useCEEDataSource();
  return (
    <LazyImage
      cacheKey={`${source.cacheKeyPrefix}-character:${character.id}:${size}`}
      initial={character.imageUrl}
      upgrade={size === "large" && Boolean(character.imageUrl)}
      className={cn("h-10 w-10", className)}
      imageClassName="object-top"
      fallback={<UserRound aria-hidden="true" />}
      request={() => source.characterImage(character.id, size)}
    />
  );
}

/** 作品封面：竖版海报，与猜番搜索的番剧封面同尺寸；没有图时用 `fallback`（条目类型图标）。 */
export function CEESubjectImage({
  subject,
  className,
  fallback,
}: {
  subject: CEESubjectSummary;
  className?: string;
  fallback: React.ReactNode;
}) {
  const source = useCEEDataSource();
  return (
    <LazyImage
      cacheKey={`${source.cacheKeyPrefix}-subject:${subject.id}`}
      initial={subject.imageUrl}
      className={cn("h-12 w-9", className)}
      fallback={fallback}
      request={() => source.subjectImage(subject.id)}
    />
  );
}
