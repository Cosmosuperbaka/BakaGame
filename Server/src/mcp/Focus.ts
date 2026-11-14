import type { AgentFocusKind, SiteFocusPayload } from "../shared/AgentActivity";
import { GAME_IDS, type AgentGameClient, type GameId } from "./GameClient";
import { findSitePage, gamePathOf, roomPageOf } from "./SiteMap";

export const focusGame = (
  client: AgentGameClient,
  args: Record<string, unknown>
): GameId | undefined => {
  if (typeof args.game === "string" && GAME_IDS.includes(args.game as GameId))
    return args.game as GameId;
  const joined = GAME_IDS.filter((game) => client.currentRoom(game));
  return joined.length === 1 ? joined[0] : undefined;
};

/** 进房类工具在完成后还要再报一次：房内页面在调用前收不到（此时还没绑定房间）。 */
export const FOCUS_AFTER_TOOLS = new Set(["list_rooms", "create_room", "join_room"]);

const lobbyPage = (game?: GameId): string => (game ? gamePathOf(game) : "/");

const roomPage = (game: GameId | undefined, roomId: unknown): string => {
  if (!game) return "/";
  const id = typeof roomId === "string" && roomId ? roomId.slice(0, 32) : undefined;
  return id ? roomPageOf(game, id) : lobbyPage(game);
};

/** 站点通道的载荷去掉发送者身份后的形状：工具函数只负责算出「在哪、做什么」。 */
type SiteLocation = Omit<SiteFocusPayload, "agentName" | "tool">;

/** 站点页的焦点在工具执行前算：`visit_page` 的 path 校验失败时仍要有一个可读的位置。 */
const pageArgOf = (args: Record<string, unknown>): string | undefined =>
  typeof args.path === "string" && args.path.startsWith("/") ? args.path.slice(0, 96) : undefined;

const pageFocus = (args: Record<string, unknown>): SiteLocation => {
  const requested = pageArgOf(args);
  const page = findSitePage(requested ?? "/");
  return {
    kind: "site",
    page: page?.path ?? requested ?? "/",
    ...(page ? { label: page.title } : {}),
  };
};

/** 位置口径：`lobby` 只看大厅页，`room` 优先用参数里的房间号，`current` 用当前所在房间。 */
type FocusPlace = "lobby" | "room" | "current";

/**
 * 工具 → 位置口径。写成表而不是 switch：同一个对象形状在九个分支里重复三遍，
 * 既抬认知复杂度，也让「加一个工具」变成复制粘贴。
 */
const SITE_FOCUS_TARGETS: Record<string, { kind: AgentFocusKind; place: FocusPlace }> = {
  list_rooms: { kind: "lobby", place: "lobby" },
  create_room: { kind: "enter_room", place: "room" },
  join_room: { kind: "enter_room", place: "room" },
  leave_room: { kind: "lobby", place: "lobby" },
  get_screen: { kind: "state", place: "current" },
  ui_run: { kind: "action", place: "current" },
};

/** 未登记的工具按「在当前位置做了一件事」上报，保证首页始终能看到 Agent 的落点。 */
const DEFAULT_SITE_FOCUS: { kind: AgentFocusKind; place: FocusPlace } = {
  kind: "action",
  place: "current",
};

/**
 * 工具 → 站点级焦点。站点通道是**公开广播**：只带「在哪、做什么」，
 * 不带搜索词、猜测、聊天草稿与控件逐字输入。
 *
 * 返回 `undefined` 表示这次调用不该出现在首页（纯文档读取，不改变位置）。
 */
export function siteFocusForTool(
  tool: string,
  args: Record<string, unknown>,
  client: AgentGameClient
): SiteLocation | undefined {
  if (tool === "get_mcp_policy") return undefined;
  if (tool === "get_site_map") return { kind: "site", page: "/" };
  if (tool === "visit_page") return pageFocus(args);
  // 标签页接管：导航沿用 path，其余只报「在做一件事」，不把页面内容塞进公开广播。
  if (tool === "page_state" || tool === "release_page") return undefined;
  if (tool === "control_page") return { kind: "site" };
  if (tool === "page_act")
    return args.action === "navigate" && pageArgOf(args) ? pageFocus(args) : { kind: "action" };
  const { kind, place } = SITE_FOCUS_TARGETS[tool] ?? DEFAULT_SITE_FOCUS;
  const game = focusGame(client, args);
  const current = game ? client.currentRoom(game) : undefined;
  const argument = typeof args.roomId === "string" && args.roomId ? args.roomId : undefined;
  const roomId =
    place === "room" ? (argument ?? current) : place === "current" ? current : undefined;
  return {
    kind,
    ...(game ? { game } : {}),
    ...(roomId ? { roomId } : {}),
    page: place === "lobby" ? lobbyPage(game) : roomPage(game, roomId),
  };
}

/**
 * 上报站点活动：首页与大厅的访客看到 Agent 当前在哪一页、在做什么。
 * 它只是增强信息，所以不等待：连接不上或服务端迟迟不应答时，工具调用不能被它拖住几秒。
 */
export function publishToolFocus(
  client: AgentGameClient,
  agentName: string,
  tool: string,
  args: Record<string, unknown>
): void {
  const siteFocus = siteFocusForTool(tool, args, client);
  if (siteFocus)
    void client.publishSiteFocus({ agentName: agentName.slice(0, 32), tool, ...siteFocus });
}
