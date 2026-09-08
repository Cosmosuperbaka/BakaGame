import { Suspense } from "react";
import { Outlet } from "react-router-dom";
import { SonGuessrProvider } from "@/contexts/SonGuessrContext";
import { SonGuessrToastContainer } from "@/components/Toast";
import { PageLoadingFallback } from "@/components/common/PageLoadingFallback";

export function SonGuessrLayout() {
  return (
    <SonGuessrProvider>
      <Suspense fallback={<PageLoadingFallback />}>
        <Outlet />
      </Suspense>
      <SonGuessrToastContainer />
    </SonGuessrProvider>
  );
}

export default SonGuessrLayout;
