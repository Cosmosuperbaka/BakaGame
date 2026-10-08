import { useEffect, useRef, useState, type ReactNode } from "react";
import { cn } from "@/lib/Utils";

/**
 * 列表里的图：自带地址就直接用；没有时等它滚进视口再向服务端要一次。
 *
 * 只读数据集不含图片地址，搜索结果默认没有封面，逐条回源又会撞上游限流；
 * 这里让「看得见的那几条」才真正发起请求。同一张图按 `cacheKey` 全局合并、
 * 有界缓存；图没回来或加载失败时显示 `fallback`，不阻断文字选择。
 */
const CACHE_LIMIT = 256;
const resolvedImages = new Map<string, string>();
const pendingImages = new Map<string, Promise<string | undefined>>();

function resolveImage(cacheKey: string, request: () => Promise<string | undefined>): Promise<string | undefined> {
  const cached = resolvedImages.get(cacheKey);
  if (cached) return Promise.resolve(cached);
  let pending = pendingImages.get(cacheKey);
  if (!pending) {
    pending = request().then((url) => {
      if (url) {
        if (resolvedImages.size >= CACHE_LIMIT) resolvedImages.delete(resolvedImages.keys().next().value!);
        resolvedImages.set(cacheKey, url);
      }
      return url;
    }).finally(() => pendingImages.delete(cacheKey));
    pendingImages.set(cacheKey, pending);
  }
  return pending;
}

export function LazyImage({ cacheKey, initial, request, className, imageClassName, fallback }: {
  /** 全局去重与缓存的键：同一张图跨列表、跨重渲染只请求一次。 */
  cacheKey: string;
  /** 服务端已经带回来的地址；有了就不必等到滚进视口。 */
  initial?: string;
  request: () => Promise<string | undefined>;
  className?: string;
  imageClassName?: string;
  fallback: ReactNode;
}) {
  const container = useRef<HTMLSpanElement>(null);
  const [image, setImage] = useState<string | undefined>(initial ?? resolvedImages.get(cacheKey));
  const [failed, setFailed] = useState(false);
  // `request` 常是内联箭头函数，放进依赖会让 effect 每次渲染重跑；用 ref 取最新值。
  const latestRequest = useRef(request);
  useEffect(() => { latestRequest.current = request; }, [request]);
  useEffect(() => {
    if (initial || image || !container.current || typeof IntersectionObserver === "undefined") return;
    let active = true;
    const observer = new IntersectionObserver((entries) => {
      if (!entries.some((entry) => entry.isIntersecting)) return;
      observer.disconnect();
      void resolveImage(cacheKey, () => latestRequest.current()).then((url) => { if (active) setImage(url); }).catch(() => { /* 图片失败不阻断文字选择。 */ });
    });
    observer.observe(container.current);
    return () => { active = false; observer.disconnect(); };
  }, [cacheKey, initial, image]);
  return <span ref={container} className={cn("flex shrink-0 items-center justify-center overflow-hidden rounded-md bg-muted text-muted-foreground", className)}>
    {image && !failed
      ? <img src={image} alt="" className={cn("h-full w-full object-cover", imageClassName)} loading="lazy" decoding="async" onError={() => setFailed(true)} />
      : fallback}
  </span>;
}
