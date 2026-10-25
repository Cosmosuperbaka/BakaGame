import { useEffect, useRef } from "react";
import { useLocation } from "react-router-dom";
import { startCloudSync, useCloudSyncEnabled } from "@/lib/CloudSync";
import { reportVisit, visitSection } from "@/lib/VisitReport";
import { useAccountStore } from "@/stores/UseAccountStore";

/**
 * 根布局里的账号引导：首屏取一次登录状态，登录期间运行云同步，按板块上报访问。
 * 游客与账号系统未启用时只有访问上报（失败静默），不影响任何游戏流程。
 */
export function useAccountBootstrap() {
  const status = useAccountStore((state) => state.status);
  const load = useAccountStore((state) => state.load);
  const syncEnabled = useCloudSyncEnabled();
  const { pathname } = useLocation();
  const lastSection = useRef<string | null>(null);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    if (status !== "signedIn" || !syncEnabled) return;
    return startCloudSync();
  }, [status, syncEnabled]);

  useEffect(() => {
    const section = visitSection(pathname);
    if (section === lastSection.current) return;
    lastSection.current = section;
    reportVisit(pathname);
  }, [pathname]);
}
