import { useEffect, useRef, useState } from "react";
import { UserRound } from "lucide-react";
import type { CCBCharacterSummary } from "@bakagame/shared";
import { useCCBStore } from "@/stores/UseCCBStore";
import { cn } from "@/lib/Utils";

const resolvedImages = new Map<number, string>();
const pendingImages = new Map<number, Promise<string | undefined>>();
async function resolveImage(id: number) {
  const cached = resolvedImages.get(id);
  if (cached) return cached;
  let pending = pendingImages.get(id);
  if (!pending) {
    pending = useCCBStore.getState().sendCommand("ccb.character.image", { characterId: id }).then(({ imageUrl }) => {
      if (imageUrl) { if (resolvedImages.size >= 256) resolvedImages.delete(resolvedImages.keys().next().value!); resolvedImages.set(id, imageUrl); }
      return imageUrl;
    }).finally(() => pendingImages.delete(id));
    pendingImages.set(id, pending);
  }
  return pending;
}

export function CCBCharacterImage({ character, className }: { character: CCBCharacterSummary; className?: string }) {
  const container = useRef<HTMLSpanElement>(null);
  const [image, setImage] = useState<string | undefined>(character.imageUrl ?? resolvedImages.get(character.id));
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    if (character.imageUrl || image || !container.current) return;
    let active = true;
    const observer = new IntersectionObserver((entries) => {
      if (!entries.some((entry) => entry.isIntersecting)) return;
      observer.disconnect();
      void resolveImage(character.id).then((url) => { if (active) setImage(url); }).catch(() => { /* 图片失败不阻断文字选择。 */ });
    });
    observer.observe(container.current);
    return () => { active = false; observer.disconnect(); };
  }, [character.id, character.imageUrl, image]);
  return <span ref={container} className={cn("flex h-10 w-10 shrink-0 items-center justify-center overflow-hidden rounded-md bg-muted text-muted-foreground", className)}>
    {image && !failed ? <img src={image} alt="" className="h-full w-full object-cover object-top" loading="lazy" onError={() => setFailed(true)} /> : <UserRound aria-hidden="true" />}
  </span>;
}
