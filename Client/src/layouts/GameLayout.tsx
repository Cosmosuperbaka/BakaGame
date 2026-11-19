import { Suspense, useEffect, type ReactNode } from "react";
import { Outlet } from "react-router";
import { ToastViewport, type ToastItem } from "@/components/Toast";
import { PageLoadingFallback } from "@/components/common/PageLoadingFallback";
import { AccountDialogs } from "@/components/account/AccountEntry";
import type { ToastState } from "@/stores/room/ToastSlice";

interface GameLayoutProps {
  /** 玩法自己的连接初始化，返回清理；幂等门闩在运行时里，重复挂载不会叠订阅。 */
  init: () => () => void;
  soundBridge: ReactNode;
  toasts: readonly ToastItem[];
  /** 玩法 store 的提示动作：关闭钮与悬停暂停都落回同一份切片计时。 */
  toastActions: Pick<ToastState, "dismissToast" | "pauseToast" | "resumeToast">;
}

/** 玩法房间的外壳：连接生命周期、提示音桥、页面出口、通知与账号弹窗的次序只在这里定义一次。 */
export function GameLayout({ init, soundBridge, toasts, toastActions }: GameLayoutProps) {
  useEffect(() => init(), [init]);
  return (
    <>
      {soundBridge}
      <Suspense fallback={<PageLoadingFallback />}>
        <Outlet />
      </Suspense>
      <ToastViewport
        toasts={toasts}
        onDismiss={toastActions.dismissToast}
        onPause={toastActions.pauseToast}
        onResume={toastActions.resumeToast}
      />
      <AccountDialogs />
    </>
  );
}
