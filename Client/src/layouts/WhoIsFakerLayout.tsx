import { Suspense } from "react";
import { Outlet } from "react-router-dom";
import { WhoIsFakerProvider } from "@/contexts/WhoIsFakerContext";
import { ToastViewport } from "@/components/Toast";
import { useWhoIsFakerStore } from "@/stores/UseWhoIsFakerStore";
import { PageLoadingFallback } from "@/components/common/PageLoadingFallback";

export function WhoIsFakerLayout() {
  const toasts = useWhoIsFakerStore((state) => state.toasts);
  return (
    <WhoIsFakerProvider>
      <Suspense fallback={<PageLoadingFallback />}>
        <Outlet />
      </Suspense>
      <ToastViewport toasts={toasts} />
    </WhoIsFakerProvider>
  );
}

export default WhoIsFakerLayout;
