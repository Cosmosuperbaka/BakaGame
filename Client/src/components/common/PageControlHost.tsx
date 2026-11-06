import { useEffect, useRef } from "react";
import { useNavigate } from "react-router-dom";
import { onPageCommand, reportPageResult } from "@/lib/SiteWs";
import { clearAgentFocus, markAgentIdle, usePageControl } from "@/stores/UsePageControl";
import { AgentTakeoverLayer } from "@/components/common/AgentTakeoverLayer";

/**
 * 标签页接管的执行端：挂在根布局，全程只有一个实例，任何页面都是这一份。
 *
 * 它只负责把服务端下发的指令交给页面执行、把结果回执，并在接管结束时立刻停下手上的动作。
 * 真正的授权在服务端：没有配对码认领，这里收不到任何指令。
 * 执行模块按需加载：没有接管的页面不用多下一字节。
 */
export function PageControlHost() {
  const navigate = useNavigate();
  const { status } = usePageControl();
  const running = useRef<AbortController | null>(null);

  useEffect(
    () =>
      onPageCommand((command) => {
        running.current?.abort();
        const controller = new AbortController();
        running.current = controller;
        void import("@/lib/PageActions")
          .then(({ runPageCommand }) =>
            runPageCommand(command, {
              navigate: (path) => void navigate(path),
              signal: controller.signal,
            })
          )
          .then(reportPageResult, () =>
            reportPageResult({ id: command.id, ok: false, error: "页面执行失败" })
          )
          .finally(markAgentIdle);
      }),
    [navigate]
  );

  useEffect(() => {
    if (status === "controlled") return;
    running.current?.abort();
    running.current = null;
    clearAgentFocus();
  }, [status]);

  return <AgentTakeoverLayer />;
}
