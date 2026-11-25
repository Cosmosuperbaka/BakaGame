import { useEffect, useRef } from "react";

/**
 * 移动壳把系统返回键交给页面时派发的事件（安卓壳桥接 `Mobile/bridge/baka-bridge.js`）。
 * 名称是两端契约：桥接按字面量派发，Mobile 的脚本测试核对两处一致。
 *
 * 桥接的处理顺序：先关浮层（合成 Escape）；没有浮层时派发本事件，有监听者 `preventDefault()`
 * 就算页面接手；都没有接手时在非首页退回上一页，在首页把应用退到后台。网页端没有壳，不会收到它。
 */
export const SHELL_BACK_EVENT = "bakagame:shell-back";

/**
 * 桥接在玩家按返回**之前**询问「页面会不会接手」：接手方只 `preventDefault()`，不执行任何动作。
 * 壳据此决定预测式返回手势的预览——页面会接手（弹确认）时不预演离开，首页没人接手时交还系统
 * 播放回到桌面的动画。与 {@link SHELL_BACK_EVENT} 分开命名，旧页面不认识它，不会把询问当成真返回。
 */
export const SHELL_BACK_PROBE_EVENT = "bakagame:shell-back-probe";

/** 接手方挂上或撤下时通知桥接重新询问；只是提醒，不带任何数据。 */
export const SHELL_BACK_CHANGE_EVENT = "bakagame:shell-back-change";

const notifyChange = () => {
  window.dispatchEvent(new Event(SHELL_BACK_CHANGE_EVENT));
};

/**
 * 页面接手系统返回键：例如房间页改为弹出离开确认，而不是直接离开。
 * `enabled` 为 false 时不接手，返回照常往上一页走。只认最近一次渲染的回调。
 */
export function useShellBack(onBack: () => void, enabled = true): void {
  const latest = useRef(onBack);
  useEffect(() => {
    latest.current = onBack;
  });
  useEffect(() => {
    if (!enabled) return;
    const handle = (event: Event) => {
      // 同一次返回只交给一个接手方：嵌套的页面（如房间里的子页面）先挂的先拿到也无妨，
      // 已经被别人接手的就不再重复弹第二个确认。
      if (event.defaultPrevented) return;
      event.preventDefault();
      latest.current();
    };
    const answerProbe = (event: Event) => {
      event.preventDefault();
    };
    window.addEventListener(SHELL_BACK_EVENT, handle);
    window.addEventListener(SHELL_BACK_PROBE_EVENT, answerProbe);
    notifyChange();
    return () => {
      window.removeEventListener(SHELL_BACK_EVENT, handle);
      window.removeEventListener(SHELL_BACK_PROBE_EVENT, answerProbe);
      notifyChange();
    };
  }, [enabled]);
}
