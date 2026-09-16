import { Suspense } from "react";
import { Outlet } from "react-router-dom";
import { CCBProvider } from "@/contexts/CCBContext";
import { CCBToastContainer } from "@/components/Toast";
import { PageLoadingFallback } from "@/components/common/PageLoadingFallback";

export function CCBLayout() {
  return (
    <CCBProvider>
      <Suspense fallback={<PageLoadingFallback />}>
        <Outlet />
      </Suspense>
      <CCBToastContainer />
    </CCBProvider>
  );
}

export default CCBLayout;
