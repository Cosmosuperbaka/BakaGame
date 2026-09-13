import { useEffect, useState } from "react";
import { AnimatePresence, motion } from "framer-motion";
import { RefreshCw } from "lucide-react";
import commitHistory from "virtual:commit-history";
import { Button } from "@/components/ui/Button";
import { duration, ease, spring } from "@/lib/Motion";

const VERSION_CHECK_INTERVAL_MS = 60_000;

/**
 * 开发环境不做版本检测。
 *
 * 本地 dev server 的构建号随改动实时变化，页面资源也不存在「旧版本残留」，
 * 此时的提醒只会打断调试，因此一律禁用检测与展示。
 */
const isDevEnvironment = () => import.meta.env.DEV;

const readBuildFromHtml = (html: string) => {
  const document = new DOMParser().parseFromString(html, "text/html");
  return document.querySelector<HTMLMetaElement>('meta[name="bakagame-build"]')?.content;
};

export interface VersionUpdateNoticeProps {
  /** 是否启用版本检测与展示，全局挂载时默认开启。 */
  active?: boolean;
  /** 点击刷新时的回调，默认刷新当前页面。主要用于单元测试注入。 */
  onReload?: () => void;
}

export function VersionUpdateNotice({
  active = true,
  onReload,
}: VersionUpdateNoticeProps) {
  const [updateAvailable, setUpdateAvailable] = useState(false);

  useEffect(() => {
    if (!active || isDevEnvironment() || commitHistory.currentCommit === "dev") return;

    let disposed = false;
    let controller: AbortController | undefined;

    const check = async () => {
      controller?.abort();
      controller = new AbortController();
      try {
        const url = new URL(import.meta.env.BASE_URL, window.location.origin);
        url.searchParams.set("version-check", String(Date.now()));
        const response = await fetch(url, {
          cache: "no-store",
          headers: { Accept: "text/html" },
          signal: controller.signal,
        });
        if (!response.ok) return;
        const deployedBuild = readBuildFromHtml(await response.text());
        if (
          !disposed &&
          deployedBuild &&
          deployedBuild !== "dev" &&
          deployedBuild !== commitHistory.currentCommit
        ) {
          setUpdateAvailable(true);
        }
      } catch {
        // 版本检查失败不影响正常游玩，下一次定时或回到前台时继续检查。
      }
    };

    const handleVisibility = () => {
      if (document.visibilityState === "visible") void check();
    };

    void check();
    const timer = window.setInterval(() => void check(), VERSION_CHECK_INTERVAL_MS);
    window.addEventListener("focus", check);
    document.addEventListener("visibilitychange", handleVisibility);

    return () => {
      disposed = true;
      controller?.abort();
      window.clearInterval(timer);
      window.removeEventListener("focus", check);
      document.removeEventListener("visibilitychange", handleVisibility);
    };
  }, [active]);

  const handleReload = () => {
    if (onReload) {
      onReload();
      return;
    }
    window.location.reload();
  };

  return (
    <AnimatePresence>
      {active && updateAvailable && (
        <motion.div
          role="status"
          initial={{ opacity: 0, y: 20, scale: 0.96 }}
          animate={{ opacity: 1, y: 0, scale: 1 }}
          exit={{
            opacity: 0,
            y: 16,
            scale: 0.96,
            transition: { duration: duration.quick, ease: ease.inOut },
          }}
          transition={spring.swift}
          className="fixed bottom-[max(1.25rem,env(safe-area-inset-bottom,1.25rem))] left-1/2 z-[110] flex w-[calc(100%-2rem)] max-w-md -translate-x-1/2 items-center gap-3 rounded-md border border-border bg-card/95 px-4 py-3 text-card-foreground shadow-lg backdrop-blur-md"
        >
          <span className="min-w-0 flex-1 text-sm font-medium leading-snug">
            游戏有新版本，请刷新后继续游玩
          </span>
          <Button
            size="sm"
            className="shrink-0 gap-1.5"
            onClick={handleReload}
          >
            <RefreshCw className="h-3.5 w-3.5" />
            刷新
          </Button>
        </motion.div>
      )}
    </AnimatePresence>
  );
}

export default VersionUpdateNotice;
