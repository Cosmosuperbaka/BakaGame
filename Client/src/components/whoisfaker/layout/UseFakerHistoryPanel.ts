import { useCallback, useEffect, useId, useRef, useState } from "react";

type MobilePanel = "none" | "players" | "chat";
export type OpenDrawer = "history" | "players" | "chat" | null;

/**
 * 发言历史的两种形态共用一套状态：桌面向右扩张的侧栏，和窄屏的覆盖抽屉。
 *
 * 展开状态记下展开时的局次，而不是布尔值：回到等待阶段、换局后自然收起，
 * 不会在切换按钮已隐藏时仍盖住游戏区，也不会在下一局一进描述阶段就自己弹开。
 */
export function useFakerHistoryPanel({
  roundId,
  historyAvailable,
  desktopSidebar,
}: {
  roundId: string | undefined;
  /** 身份分配与出词阶段还没有发言，历史入口从描述阶段起才提供 */
  historyAvailable: boolean;
  /** 桌面侧栏是否挂载；窄屏没有这块侧栏，历史走抽屉 */
  desktopSidebar: boolean;
}) {
  const [mobilePanel, setMobilePanel] = useState<MobilePanel>("none");
  const [sidebarRoundKey, setSidebarRoundKey] = useState<string | null>(null);
  const [drawerRoundKey, setDrawerRoundKey] = useState<string | null>(null);
  // 收起时宽度动画还在回缩：列表继续带着历史渲染到动画结束，避免玩家列表瞬间膨胀
  const [lingering, setLingering] = useState(false);
  const panelId = useId();
  const toggleRef = useRef<HTMLButtonElement>(null);

  const roundKey = roundId ?? "";
  const historyOpen = historyAvailable && sidebarRoundKey === roundKey;
  const historyDrawerOpen = historyAvailable && drawerRoundKey === roundKey;
  const historyRendered = historyOpen || lingering;
  const openDrawer: OpenDrawer = historyDrawerOpen
    ? "history"
    : mobilePanel === "none"
      ? null
      : mobilePanel;
  // 桌面侧栏盖住游戏区时，被盖住的控件不能再停留在 Tab 序与可访问树里；
  // 窄屏没有这块侧栏，不能因为桌面留下的展开状态把游戏区锁死
  const gameInert = historyOpen && desktopSidebar;

  // 窄屏没有侧栏、也就没有动画结束事件：收起中的标记不能留着，否则回到宽屏时列表会带着历史渲染
  if (!desktopSidebar && lingering) setLingering(false);

  /** 侧栏宽度动画结束：已收起就可以不再带着发言列渲染。 */
  const onSidebarSettled = useCallback(() => {
    if (!historyOpen) setLingering(false);
  }, [historyOpen]);

  const toggleHistory = () => {
    setSidebarRoundKey(historyOpen ? null : roundKey);
    // 展开之后的收起要等宽度动画回缩完，列表才能不再带着发言列渲染
    if (!historyOpen) setLingering(true);
    // 原来在游戏区的焦点会随游戏区一起失效（浏览器丢到页面根；Safari 点按钮本就不取焦点）：
    // 展开后焦点留在收起按钮上，收起后留在展开按钮上
    toggleRef.current?.focus({ preventScroll: true });
  };

  // Escape 收起历史；只在焦点已丢失或本来就在侧栏里时把焦点还给切换按钮，不抢聊天输入框等别处的焦点
  useEffect(() => {
    if (!historyOpen) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      const active = document.activeElement;
      const focusLost =
        !active || active === document.body || document.getElementById(panelId)?.contains(active);
      setSidebarRoundKey(null);
      if (focusLost) toggleRef.current?.focus({ preventScroll: true });
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [historyOpen, panelId]);

  /** 抽屉开合：历史抽屉记局次，玩家与聊天抽屉记名称，同一时刻只开一个。 */
  const onDrawerChange = (key: string | null) => {
    setDrawerRoundKey(key === "history" ? roundKey : null);
    setMobilePanel(key === "players" || key === "chat" ? key : "none");
  };

  return {
    historyOpen,
    historyDrawerOpen,
    historyRendered,
    openDrawer,
    gameInert,
    panelId,
    toggleRef,
    toggleHistory,
    onSidebarSettled,
    onDrawerChange,
  };
}
