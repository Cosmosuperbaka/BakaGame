import { Suspense, useEffect } from "react";
import { Outlet } from "react-router-dom";
import { initCCBWs } from "@/stores/UseCCBStore";
import { ToastViewport } from "@/components/Toast";
import { useCCBStore } from "@/stores/UseCCBStore";
import { PageLoadingFallback } from "@/components/common/PageLoadingFallback";

export default function CCBLayout() {
  const notice = useCCBStore((state) => state.notice);
  const toasts = notice ? [{ id: `${notice.type}:${notice.text}`, ...notice }] : [];
  useEffect(() => initCCBWs(), []);
  return <><Suspense fallback={<PageLoadingFallback />}><Outlet /></Suspense><ToastViewport toasts={toasts} /></>;
}
