import { Suspense, useEffect } from "react";
import { Outlet } from "react-router-dom";
import { initCEEWs } from "@/stores/UseCEEStore";
import { ToastViewport } from "@/components/Toast";
import { useCEEStore } from "@/stores/UseCEEStore";
import { PageLoadingFallback } from "@/components/common/PageLoadingFallback";

export default function CEELayout() {
  const notice = useCEEStore((state) => state.notice);
  const toasts = notice ? [{ id: `${notice.type}:${notice.text}`, ...notice }] : [];
  useEffect(() => initCEEWs(), []);
  return (
    <>
      <Suspense fallback={<PageLoadingFallback />}>
        <Outlet />
      </Suspense>
      <ToastViewport toasts={toasts} />
    </>
  );
}
