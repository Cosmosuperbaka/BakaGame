import { Suspense } from "react";
import { Outlet } from "react-router-dom";
import { SonGuessrProvider } from "@/contexts/SonGuessrContext";
import { ToastViewport } from "@/components/Toast";
import { useSonGuessrStore } from "@/stores/UseSonGuessrStore";
import { PageLoadingFallback } from "@/components/common/PageLoadingFallback";

export function SonGuessrLayout() {
  const notice = useSonGuessrStore((state) => state.notice);
  const toasts = notice ? [{ id: `${notice.type}:${notice.text}`, ...notice }] : [];
  return (
    <SonGuessrProvider>
      <Suspense fallback={<PageLoadingFallback />}>
        <Outlet />
      </Suspense>
      <ToastViewport toasts={toasts} />
    </SonGuessrProvider>
  );
}

export default SonGuessrLayout;
