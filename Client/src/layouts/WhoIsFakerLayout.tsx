import { Suspense } from "react";
import { Outlet } from "react-router-dom";
import { WhoIsFakerProvider } from "@/contexts/WhoIsFakerContext";
import { ToastViewport } from "@/components/Toast";
import { useWhoIsFakerStore } from "@/stores/UseWhoIsFakerStore";
import { PageLoadingFallback } from "@/components/common/PageLoadingFallback";
import { AccountDialogs } from "@/components/account/AccountEntry";
import { FakerSoundBridge } from "@/components/whoisfaker/FakerSoundBridge";

function WhoIsFakerLayout() {
  const toasts = useWhoIsFakerStore((state) => state.toasts);
  return (
    <WhoIsFakerProvider>
      <FakerSoundBridge />
      <Suspense fallback={<PageLoadingFallback />}>
        <Outlet />
      </Suspense>
      <ToastViewport toasts={toasts} />
      <AccountDialogs />
    </WhoIsFakerProvider>
  );
}

export default WhoIsFakerLayout;
