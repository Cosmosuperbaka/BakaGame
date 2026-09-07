import { Suspense } from "react";
import { Outlet, useMatch } from "react-router-dom";
import { SonGuessrProvider } from "@/contexts/SonGuessrContext";
import { SongGuessrToastContainer } from "@/components/Toast";
import { VersionUpdateNotice } from "@/components/VersionUpdateNotice";
import { useSonGuessrStore } from "@/stores/UseSonGuessrStore";
import { PageLoadingFallback } from "@/components/common/PageLoadingFallback";

export function SonGuessrLayout() {
  const inRoom = Boolean(useMatch("/songuessr/room/:roomId"));
  const active = useSonGuessrStore((state) => inRoom && Boolean(state.roomId && state.snapshot));
  return (
    <SonGuessrProvider>
      <Suspense fallback={<PageLoadingFallback />}>
        <Outlet />
      </Suspense>
      <SongGuessrToastContainer />
      <VersionUpdateNotice active={active} />
    </SonGuessrProvider>
  );
}

export default SonGuessrLayout;
