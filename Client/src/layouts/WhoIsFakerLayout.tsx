import { Suspense } from "react";
import { Outlet, useMatch } from "react-router-dom";
import { WhoIsFakerProvider } from "@/contexts/WhoIsFakerContext";
import { ToastContainer } from "@/components/Toast";
import { VersionUpdateNotice } from "@/components/VersionUpdateNotice";
import { useWhoIsFakerStore } from "@/stores/UseWhoIsFakerStore";
import { PageLoadingFallback } from "@/components/common/PageLoadingFallback";

export function WhoIsFakerLayout() {
  const inRoom = Boolean(useMatch("/whoisfaker/room/:roomId"));
  const active = useWhoIsFakerStore((state) => inRoom && Boolean(state.roomId && state.snapshot));
  return (
    <WhoIsFakerProvider>
      <Suspense fallback={<PageLoadingFallback />}>
        <Outlet />
      </Suspense>
      <ToastContainer />
      <VersionUpdateNotice active={active} />
    </WhoIsFakerProvider>
  );
}

export default WhoIsFakerLayout;
