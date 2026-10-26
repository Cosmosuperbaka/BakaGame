import { useEffect } from "react";
import { useWhoIsFakerStore } from "@/stores/UseWhoIsFakerStore";
import { useSonGuessrStore } from "@/stores/UseSonGuessrStore";
import { useCEEStore } from "@/stores/UseCEEStore";

type GameId = "faker" | "song" | "cee";

/**
 * MCP 接管期间的输入冻结：不使用遮罩或模糊，只把 #root 设为 inert 并拦截键盘/快捷键。
 * 画面保持原样，也不放置任何手动收回入口；恢复控制由 Agent 的 mcp.release 或断线触发。
 */
export function McpSeatLockOverlay({ game }: { game: GameId }) {
  const fakerControlled = useWhoIsFakerStore((state) => state.privateState?.mcpControlled === true);
  const songControlled = useSonGuessrStore((state) => state.privateState?.mcpControlled === true);
  const ceeControlled = useCEEStore((state) => state.privateState?.mcpControlled === true);
  const controlled =
    game === "faker" ? fakerControlled : game === "song" ? songControlled : ceeControlled;

  useEffect(() => {
    if (!controlled) return;
    const root = document.getElementById("root");
    root?.setAttribute("inert", "");
    // 保留浏览器级快捷键（刷新、开发者工具等），其余键入与游戏快捷键全部拦下。
    const block = (event: KeyboardEvent | InputEvent) => {
      if (
        event instanceof KeyboardEvent &&
        (event.metaKey || event.ctrlKey || event.key === "F5" || event.key === "F12")
      )
        return;
      event.preventDefault();
      event.stopPropagation();
    };
    document.addEventListener("keydown", block, true);
    document.addEventListener("keypress", block, true);
    document.addEventListener("beforeinput", block, true);
    return () => {
      root?.removeAttribute("inert");
      document.removeEventListener("keydown", block, true);
      document.removeEventListener("keypress", block, true);
      document.removeEventListener("beforeinput", block, true);
    };
  }, [controlled]);

  return null;
}
