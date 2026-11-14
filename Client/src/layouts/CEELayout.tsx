import { useEffect } from "react";
import { initCEEWs, useCEEStore } from "@/stores/UseCEEStore";
import { requestLogin } from "@/components/account/AccountEntry";
import { CEESoundBridge } from "@/components/cee/CEESoundBridge";
import { GameLayout } from "@/layouts/GameLayout";

export default function CEELayout() {
  const toasts = useCEEStore((state) => state.toasts);
  const requestLoginAt = useCEEStore((state) => state.requestLoginAt);
  // LOGIN_REQUIRED 由 Store 记下时刻，这里（挂着登录弹窗的一层）去打开它。
  useEffect(() => {
    if (requestLoginAt) requestLogin();
  }, [requestLoginAt]);
  return <GameLayout init={initCEEWs} soundBridge={<CEESoundBridge />} toasts={toasts} />;
}
