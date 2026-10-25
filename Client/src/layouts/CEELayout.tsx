import { Suspense, useEffect } from "react";
import { Outlet } from "react-router-dom";
import { initCEEWs } from "@/stores/UseCEEStore";
import { ToastViewport } from "@/components/Toast";
import { useCEEStore } from "@/stores/UseCEEStore";
import { AccountDialogs, requestLogin } from "@/components/account/AccountEntry";
import { PageLoadingFallback } from "@/components/common/PageLoadingFallback";
import { CEESoundBridge } from "@/components/cee/CEESoundBridge";

export default function CEELayout() {
  const notice = useCEEStore((state) => state.notice);
  const requestLoginAt = useCEEStore((state) => state.requestLoginAt);
  const toasts = notice ? [{ id: `${notice.type}:${notice.text}`, ...notice }] : [];
  useEffect(() => initCEEWs(), []);
  // LOGIN_REQUIRED 由 Store 记下时刻，这里（挂着登录弹窗的一层）去打开它。
  useEffect(() => {
    if (requestLoginAt) requestLogin();
  }, [requestLoginAt]);
  return (
    <>
      <CEESoundBridge />
      <Suspense fallback={<PageLoadingFallback />}>
        <Outlet />
      </Suspense>
      <ToastViewport toasts={toasts} />
      <AccountDialogs />
    </>
  );
}
