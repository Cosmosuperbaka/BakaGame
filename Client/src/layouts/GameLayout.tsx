import { Suspense, type ReactNode } from "react";
import { Outlet } from "react-router";
import { ToastViewport, type ToastItem } from "@/components/Toast";
import { PageLoadingFallback } from "@/components/common/PageLoadingFallback";
import { AccountDialogs } from "@/components/account/AccountEntry";

interface GameLayoutProps {
  soundBridge: ReactNode;
  toasts: readonly ToastItem[];
}

/** 玩法房间的外壳：提示音桥、页面出口、通知与账号弹窗的次序只在这里定义一次。 */
export function GameLayout({ soundBridge, toasts }: GameLayoutProps) {
  return (
    <>
      {soundBridge}
      <Suspense fallback={<PageLoadingFallback />}>
        <Outlet />
      </Suspense>
      <ToastViewport toasts={toasts} />
      <AccountDialogs />
    </>
  );
}
