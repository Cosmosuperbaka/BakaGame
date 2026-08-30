import { useEffect, useState } from "react";
import { RefreshCw } from "lucide-react";
import commitHistory from "virtual:commit-history";
import { Button } from "@/components/ui/Button";

const VERSION_CHECK_INTERVAL_MS = 60_000;

const readBuildFromHtml = (html: string) => {
  const document = new DOMParser().parseFromString(html, "text/html");
  return document.querySelector<HTMLMetaElement>('meta[name="bakagame-build"]')?.content;
};

export function VersionUpdateNotice({ active }: { active: boolean }) {
  const [updateAvailable, setUpdateAvailable] = useState(false);

  useEffect(() => {
    if (!active || commitHistory.currentCommit === "dev") return;

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
        // 版本检查失败不影响当前游戏，下一次定时或回到前台时继续检查。
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

  if (!active || !updateAvailable) return null;

  return (
    <div
      role="status"
      className="fixed inset-x-3 bottom-3 z-[110] mx-auto flex max-w-md items-center gap-3 rounded-md border border-amber-300 bg-amber-50 px-4 py-3 text-sm text-amber-950 shadow-lg"
    >
      <span className="min-w-0 flex-1">游戏有新版本，请刷新后继续游玩</span>
      <Button
        size="sm"
        className="shrink-0 gap-1.5"
        onClick={() => window.location.reload()}
      >
        <RefreshCw className="h-3.5 w-3.5" />
        刷新
      </Button>
    </div>
  );
}
