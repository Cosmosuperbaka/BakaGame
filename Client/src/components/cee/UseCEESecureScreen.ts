import { useEffect } from "react";
import { setSecureScreen } from "@/lib/BakaChannel";

/**
 * 需要挡录屏的画面（反作弊房、排位系列赛）挂载期间开启窗口级防截屏。
 * 必须由「与该画面同时在树上」的组件调用：路由层的兄弟页不会同时挂载，放错页面就静默失效。
 * 关闭放在清理里，卸载、切房与开关翻转都会恢复；网页环境没有壳对象，底层静默跳过。
 */
export function useCEESecureScreen(enabled: boolean) {
  useEffect(() => {
    setSecureScreen(enabled);
    return () => setSecureScreen(false);
  }, [enabled]);
}
