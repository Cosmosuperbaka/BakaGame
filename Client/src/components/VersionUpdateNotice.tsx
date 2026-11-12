import { useEffect, useState } from "react";
import { AnimatePresence, motion } from "framer-motion";
import { RefreshCw } from "lucide-react";
import commitHistory from "virtual:commit-history";
import { Button } from "@/components/ui/Button";
import { bakaClientType } from "@/lib/BakaChannel";
import { bannerRise } from "@/lib/Motion";

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

export function VersionUpdateNotice({ active = true, onReload }: VersionUpdateNoticeProps) {
  const [updateAvailable, setUpdateAvailable] = useState(false);

  useEffect(() => {
    // 移动壳的页面来自内嵌/热更新资源，拿它和本地 HTML 比永远是同一个构建；
    // 移动端的新资源由 `/api/client/web-bundle` 那条链路负责，这里不做无效轮询。
    if (
      !active ||
      isDevEnvironment() ||
      bakaClientType() === "mobile" ||
      commitHistory.currentCommit === "dev"
    ) {
      return;
    }

    let disposed = false;
    // 不用 AbortController 取消上一次请求：被取消的请求会让 SDK 对响应体的旁路读取
    // 变成未处理的 AbortError 上报。改为同一时刻只保留一个在途检查，其余直接跳过。
    let checking = false;

    const check = async () => {
      if (checking) return;
      checking = true;
      try {
        const url = new URL(import.meta.env.BASE_URL, window.location.origin);
        url.searchParams.set("version-check", String(Date.now()));
        const response = await fetch(url, {
          cache: "no-store",
          headers: { Accept: "text/html" },
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
      } finally {
        checking = false;
      }
    };

    const handleVisibility = () => {
      if (document.visibilityState === "visible") void check();
    };

    const handleFocus = () => {
      void check();
    };

    void check();
    const timer = window.setInterval(() => void check(), VERSION_CHECK_INTERVAL_MS);
    window.addEventListener("focus", handleFocus);
    document.addEventListener("visibilitychange", handleVisibility);

    return () => {
      disposed = true;
      window.clearInterval(timer);
      window.removeEventListener("focus", handleFocus);
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

  return <VersionUpdateBanner open={active && updateAvailable} onReload={handleReload} />;
}

export interface VersionUpdateBannerProps {
  open: boolean;
  onReload: () => void;
}

/** 新版本提醒的展示部分，只由 Props 驱动；检测逻辑留在 VersionUpdateNotice，Storybook 直接渲染这一层。 */
export function VersionUpdateBanner({ open, onReload }: VersionUpdateBannerProps) {
  return (
    <AnimatePresence>
      {open && (
        <motion.div
          role="status"
          variants={bannerRise}
          initial="initial"
          animate="animate"
          exit="exit"
          className="fixed bottom-[max(1.25rem,env(safe-area-inset-bottom,1.25rem))] left-1/2 z-toast flex w-[calc(100%-2rem)] max-w-md -translate-x-1/2 items-center gap-3 rounded-md border border-border bg-card/95 px-4 py-3 text-card-foreground shadow-lg backdrop-blur-md"
        >
          {/* 短句按标点断行（keep-all）：窄屏折成「游戏有新版本，」「请刷新后继续游玩」两半，不在「继续」中间断开 */}
          <p className="min-w-0 flex-1 break-keep text-sm font-medium leading-snug">
            游戏有新版本，请刷新后继续游玩
          </p>
          <Button size="sm" className="shrink-0 gap-1.5" onClick={onReload}>
            <RefreshCw className="h-3.5 w-3.5" />
            刷新
          </Button>
        </motion.div>
      )}
    </AnimatePresence>
  );
}
