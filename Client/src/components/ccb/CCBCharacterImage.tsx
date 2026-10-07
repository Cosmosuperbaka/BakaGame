import { useEffect, useRef, useState, type ReactNode } from "react";
import { UserRound } from "lucide-react";
import type { CCBCharacterSummary, CCBSubjectSummary } from "@bakagame/shared";
import { useCCBStore } from "@/stores/UseCCBStore";
import { cn } from "@/lib/Utils";

type ImageKind = "character" | "subject";

const resolvedImages = new Map<string, string>();
const pendingImages = new Map<string, Promise<string | undefined>>();
async function resolveImage(kind: ImageKind, id: number) {
  const key = `${kind}:${id}`;
  const cached = resolvedImages.get(key);
  if (cached) return cached;
  let pending = pendingImages.get(key);
  if (!pending) {
    const store = useCCBStore.getState();
    const request = kind === "character"
      ? store.sendCommand("ccb.character.image", { characterId: id })
      : store.sendCommand("ccb.subject.image", { subjectId: id });
    pending = request.then(({ imageUrl }) => {
      if (imageUrl) { if (resolvedImages.size >= 256) resolvedImages.delete(resolvedImages.keys().next().value!); resolvedImages.set(key, imageUrl); }
      return imageUrl;
    }).finally(() => pendingImages.delete(key));
    pendingImages.set(key, pending);
  }
  return pending;
}

/**
 * 列表里的图：自带地址就直接用；没有时等它滚进视口再向服务端要一次（同一张图全局合并、有界缓存）。
 * 图没回来或加载失败时显示 `fallback`，不阻断文字选择。
 */
function LazyImage({ kind, id, initial, className, imageClassName, fallback }: {
  kind: ImageKind; id: number; initial?: string; className?: string; imageClassName?: string; fallback: ReactNode;
}) {
  const container = useRef<HTMLSpanElement>(null);
  const [image, setImage] = useState<string | undefined>(initial ?? resolvedImages.get(`${kind}:${id}`));
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    if (initial || image || !container.current || typeof IntersectionObserver === "undefined") return;
    let active = true;
    const observer = new IntersectionObserver((entries) => {
      if (!entries.some((entry) => entry.isIntersecting)) return;
      observer.disconnect();
      void resolveImage(kind, id).then((url) => { if (active) setImage(url); }).catch(() => { /* 图片失败不阻断文字选择。 */ });
    });
    observer.observe(container.current);
    return () => { active = false; observer.disconnect(); };
  }, [kind, id, initial, image]);
  return <span ref={container} className={cn("flex shrink-0 items-center justify-center overflow-hidden rounded-md bg-muted text-muted-foreground", className)}>
    {image && !failed ? <img src={image} alt="" className={cn("h-full w-full object-cover", imageClassName)} loading="lazy" decoding="async" onError={() => setFailed(true)} /> : fallback}
  </span>;
}

export function CCBCharacterImage({ character, className }: { character: CCBCharacterSummary; className?: string }) {
  return <LazyImage kind="character" id={character.id} initial={character.imageUrl} className={cn("h-10 w-10", className)}
    imageClassName="object-top" fallback={<UserRound aria-hidden="true" />} />;
}

/** 作品封面：竖版海报，与猜番搜索的番剧封面同尺寸；没有图时用 `fallback`（条目类型图标）。 */
export function CCBSubjectImage({ subject, className, fallback }: { subject: CCBSubjectSummary; className?: string; fallback: ReactNode }) {
  return <LazyImage kind="subject" id={subject.id} initial={subject.imageUrl} className={cn("h-12 w-9", className)} fallback={fallback} />;
}
