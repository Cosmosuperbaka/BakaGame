/** 页面向服务端上报的可操作面：位置 + 可见控件，不含输入内容与聊天正文。 */
export interface PageStateReport {
  path: string;
  title: string;
  controls: Array<{ id: string; label: string }>;
  game?: "faker" | "song" | "cee";
  roomId?: string;
}

const GAME_PREFIXES: ReadonlyArray<readonly [string, "faker" | "song" | "cee"]> = [
  ["/whoisfaker", "faker"],
  ["/songuessr", "song"],
  ["/cee", "cee"],
];

/** 房间路径与三款游戏的路由同形：`/<game>/room/<roomId>`。 */
const ROOM_PATH = /\/(?:whoisfaker|songuessr|cee)\/room\/([A-Za-z0-9_-]{2,32})/;

/** 上报的页面状态最多带 32 个控件：首页与大厅的可点目标远少于此。 */
const MAX_CONTROLS = 32;

/**
 * 采集当前页面的可操作面。
 *
 * 只取 `data-agent-control` 标注过的元素与它们的可读标签：输入框内容、聊天正文、
 * 谜底都不进这条通道——Agent 要的是「能点哪里」，不是把页面抓下来。
 */
export const snapshotPageState = (pathname: string): PageStateReport => {
  const controls = [...document.querySelectorAll<HTMLElement>("[data-agent-control]")]
    .slice(0, MAX_CONTROLS)
    .map((element) => ({
      id: element.dataset.agentControl ?? "",
      label: (element.getAttribute("aria-label") ?? element.textContent ?? "").trim().slice(0, 48),
    }))
    .filter((control) => control.id.length > 0);
  const game = GAME_PREFIXES.find(
    ([prefix]) => pathname === prefix || pathname.startsWith(`${prefix}/`)
  )?.[1];
  const roomId = ROOM_PATH.exec(pathname)?.[1];
  return {
    path: pathname.slice(0, 96) || "/",
    title: document.title.slice(0, 64),
    controls,
    ...(game ? { game } : {}),
    ...(roomId ? { roomId } : {}),
  };
};

/** 按控件 id 点击页面上的元素；找不到就返回 false，由调用方回执失败。 */
export const clickByControl = (controlId: string): boolean => {
  const escaped =
    typeof CSS !== "undefined" && typeof CSS.escape === "function"
      ? CSS.escape(controlId)
      : controlId.replace(/["\\]/g, "\\$&");
  const target = document.querySelector<HTMLElement>(`[data-agent-control="${escaped}"]`);
  if (!target) return false;
  target.click();
  return true;
};
