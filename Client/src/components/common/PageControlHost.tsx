import { useEffect } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import { clickByControl, snapshotPageState } from "@/lib/PageState";
import { onPageCommand, reportPageResult, reportPageState } from "@/lib/SiteWs";
import { usePageControl } from "@/stores/UsePageControl";

/**
 * 页面接管的执行端：挂在根布局，全程只有一个实例。
 *
 * 它只做三件事——执行服务端下发的导航/点击、把执行结果回执、在接管期间持续上报
 * 「我在哪一页、能点哪些控件」。真正的授权在服务端：没有配对码认领，这里收不到任何指令。
 */
export function PageControlHost() {
  const navigate = useNavigate();
  const { pathname } = useLocation();
  const { status } = usePageControl();

  useEffect(
    () =>
      onPageCommand((command) => {
        if (command.action === "navigate") {
          if (!command.path) {
            reportPageResult({ id: command.id, ok: false, error: "缺少导航目标" });
            return;
          }
          // 路由跳转本身可能返回 Promise（数据路由），这里不阻塞回执：
          // 指令的成功只代表「已接受导航」，150ms 后的补报才是 Agent 看到的落点。
          void navigate(command.path);
          reportPageResult({ id: command.id, ok: true });
          window.setTimeout(
            () => reportPageState(snapshotPageState(window.location.pathname)),
            150
          );
          return;
        }
        if (!command.control || !clickByControl(command.control)) {
          reportPageResult({
            id: command.id,
            ok: false,
            error: `当前页面没有可点控件：${command.control ?? ""}`,
          });
          return;
        }
        reportPageResult({ id: command.id, ok: true });
        // 点击后页面要等异步数据才会长出下一批控件，稍等再报一次。
        window.setTimeout(() => reportPageState(snapshotPageState(window.location.pathname)), 400);
      }),
    [navigate]
  );

  useEffect(() => {
    if (status === "off") return;
    reportPageState(snapshotPageState(pathname));
    // 页面数据是异步到的：接管期间按固定间隔补齐控件清单，避免 Agent 看到空列表。
    const timer = window.setInterval(
      () => reportPageState(snapshotPageState(window.location.pathname)),
      2_000
    );
    return () => window.clearInterval(timer);
  }, [status, pathname]);

  return null;
}
