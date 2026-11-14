import { Suspense, useEffect, type ReactNode } from "react";
import { Outlet } from "react-router";
import { ToastViewport, type ToastItem } from "@/components/Toast";
import { PageLoadingFallback } from "@/components/common/PageLoadingFallback";
import { AccountDialogs } from "@/components/account/AccountEntry";

interface GameLayoutProps {
  /** 玩法自己的连接初始化，返回清理；幂等门闩在运行时里，重复挂载不会叠订阅。 */
  init: () => () => void;
  soundBridge: ReactNode;
  toasts: readonly ToastItem[];
}

/** 玩法房间的外壳：连接生命周期、提示音桥、页面出口、通知与账号弹窗的次序只在这里定义一次。 */
export function GameLayout({ init, soundBridge, toasts }: GameLayoutProps) {
  useEffect(() => init(), [init]);
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
