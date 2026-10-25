import { Suspense } from "react";
import { Outlet } from "react-router-dom";
import { SonGuessrProvider } from "@/contexts/SonGuessrContext";
import { ToastViewport } from "@/components/Toast";
import { useSonGuessrStore } from "@/stores/UseSonGuessrStore";
import { PageLoadingFallback } from "@/components/common/PageLoadingFallback";
import { AccountDialogs } from "@/components/account/AccountEntry";
import { SongSoundBridge } from "@/components/songuessr/SongSoundBridge";

function SonGuessrLayout() {
  const notice = useSonGuessrStore((state) => state.notice);
  const toasts = notice ? [{ id: `${notice.type}:${notice.text}`, ...notice }] : [];
  return (
    <SonGuessrProvider>
      <SongSoundBridge />
      <Suspense fallback={<PageLoadingFallback />}>
        <Outlet />
      </Suspense>
      <ToastViewport toasts={toasts} />
      <AccountDialogs />
    </SonGuessrProvider>
  );
}

export default SonGuessrLayout;
