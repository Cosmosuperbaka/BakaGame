import { Suspense } from "react";
import { Outlet } from "react-router-dom";
import { WhoIsFakerProvider } from "@/contexts/WhoIsFakerContext";
import { ToastContainer } from "@/components/Toast";
import { PageLoadingFallback } from "@/components/common/PageLoadingFallback";

export function WhoIsFakerLayout() {
  return (
    <WhoIsFakerProvider>
      <Suspense fallback={<PageLoadingFallback />}>
        <Outlet />
      </Suspense>
      <ToastContainer />
    </WhoIsFakerProvider>
  );
}

export default WhoIsFakerLayout;
