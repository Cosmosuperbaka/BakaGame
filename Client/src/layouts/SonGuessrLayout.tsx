import { Suspense } from "react";
import { Outlet } from "react-router-dom";
import { SonGuessrProvider } from "@/contexts/SonGuessrContext";
import { ToastViewport } from "@/components/Toast";
import { useSonGuessrStore } from "@/stores/UseSonGuessrStore";
import { PageLoadingFallback } from "@/components/common/PageLoadingFallback";
import { AccountDialogs } from "@/components/account/AccountEntry";
import { SongSoundBridge } from "@/components/songuessr/SongSoundBridge";

function SonGuessrLayout() {
  const toast = useSonGuessrStore((state) => state.toast);
  const toasts = toast ? [{ id: `${toast.type}:${toast.text}`, ...toast }] : [];
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
