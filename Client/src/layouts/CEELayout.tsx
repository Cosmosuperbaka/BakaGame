import { useEffect } from "react";
import { initCEEWs } from "@/stores/UseCEEStore";
import { useCEEStore } from "@/stores/UseCEEStore";
import { requestLogin } from "@/components/account/AccountEntry";
import { CEESoundBridge } from "@/components/cee/CEESoundBridge";
import { GameLayout } from "@/layouts/GameLayout";
import { toToastItems } from "@/layouts/ToastItems";

export default function CEELayout() {
  const toast = useCEEStore((state) => state.toast);
  const requestLoginAt = useCEEStore((state) => state.requestLoginAt);
  useEffect(() => initCEEWs(), []);
  // LOGIN_REQUIRED 由 Store 记下时刻，这里（挂着登录弹窗的一层）去打开它。
  useEffect(() => {
    if (requestLoginAt) requestLogin();
  }, [requestLoginAt]);
  return <GameLayout soundBridge={<CEESoundBridge />} toasts={toToastItems(toast)} />;
}
