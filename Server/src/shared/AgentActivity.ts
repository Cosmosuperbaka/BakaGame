import type { GameId } from "./Protocol";
import { Type as t, type Static } from "@sinclair/typebox";

export const AGENT_FOCUS_KINDS = [
  "site",
  "lobby",
  "enter_room",
  "state",
  "private_state",
  "record",
  "song_search",
  "song_audio",
  "cee_search",
  "vote",
  "describe",
  "submit_words",
  "submit_song",
  "guess",
  "set_answer",
  "image_hint",
  "chat",
  "settings",
  "claim",
  "action",
] as const;

export type AgentFocusKind = (typeof AGENT_FOCUS_KINDS)[number];

/** 房间页的五个界面区域；客户端按它把没有控件标记的焦点退回整块区域。 */
export const AGENT_FOCUS_PARTS = [
  "header",
  "player",
  "game",
  "chat",
  "settings",
  "dialog",
] as const;

export type AgentFocusPart = (typeof AGENT_FOCUS_PARTS)[number];

/**
 * Agent 上报「正在看/操作哪个控件」。
 *
 * `input` 是逐步输入的当前文本，只发给被接管座位的人类查看器，不广播给同房其他玩家：
 * 搜索词、猜测和发言都可能提前泄露意图。
 */
export const AgentFocusInputSchema = t.Object(
  {
    agentName: t.String({ minLength: 1, maxLength: 32 }),
    tool: t.String({ minLength: 1, maxLength: 64 }),
    action: t.Optional(t.String({ maxLength: 64 })),
    // 用短字符串而不是字面量联合：把三款游戏的整张命令表推导到过深会导致类型实例化爆炸。
    // 真正的取值校验在服务端 handleAgentFocus 里按 AGENT_FOCUS_KINDS 做。
    kind: t.String({ minLength: 1, maxLength: 32 }),
    targetId: t.Optional(t.String({ maxLength: 64 })),
    controlId: t.Optional(t.String({ pattern: "^[A-Za-z0-9_.:-]{1,96}$" })),
    part: t.Optional(t.String({ maxLength: 16 })),
    label: t.Optional(t.String({ maxLength: 48 })),
    input: t.Optional(t.String({ maxLength: 200 })),
  },
  { additionalProperties: false }
);

export type AgentFocusInput = Static<typeof AgentFocusInputSchema>;

export const isAgentFocusKind = (value: string): value is AgentFocusKind =>
  (AGENT_FOCUS_KINDS as readonly string[]).includes(value);

export const isAgentFocusPart = (value: string): value is AgentFocusPart =>
  (AGENT_FOCUS_PARTS as readonly string[]).includes(value);

export interface AgentFocusEvent extends Omit<AgentFocusInput, "kind" | "part"> {
  kind: AgentFocusKind;
  part?: AgentFocusPart;
  game: GameId;
  roomId?: string;
  playerId?: string;
  at: number;
}

// ==================== 站点级 Agent 活动（统一 ws 入口的公开只读通道） ====================

/** 站点通道的三个命令：订阅、上报焦点、离开。它们由统一入口直接处理，不进任何游戏服务。 */
export const SITE_SUBSCRIBE_COMMAND = "site.subscribe";
export const SITE_FOCUS_COMMAND = "site.focus";
export const SITE_LEAVE_COMMAND = "site.leave";

export const SITE_SUBSCRIBE_COMMAND_SET: ReadonlySet<string> = new Set([
  SITE_SUBSCRIBE_COMMAND,
  SITE_FOCUS_COMMAND,
  SITE_LEAVE_COMMAND,
]);

export const SITE_AGENTS_EVENT = "site.agents";
export const SITE_AGENT_EVENT = "site.agent";
export const SITE_AGENT_LEFT_EVENT = "site.agent.left";

const siteGameSchema = t.Optional(
  t.Union([t.Literal("faker"), t.Literal("song"), t.Literal("cee")])
);

/**
 * Agent 上报的站点级焦点。字段是**封闭集合**：房间内的控件焦点与逐字输入进度不进这条通道，
 * 它会广播给所有打开首页的访客，搜索词、猜测与聊天草稿都可能在里面。
 */
export const SiteFocusPayloadSchema = t.Object(
  {
    agentName: t.String({ minLength: 1, maxLength: 32 }),
    tool: t.String({ minLength: 1, maxLength: 64 }),
    kind: t.String({ minLength: 1, maxLength: 32 }),
    game: siteGameSchema,
    roomId: t.Optional(t.String({ maxLength: 32 })),
    page: t.Optional(t.String({ maxLength: 96 })),
    label: t.Optional(t.String({ maxLength: 48 })),
  },
  { additionalProperties: false }
);

export type SiteFocusPayload = Static<typeof SiteFocusPayloadSchema>;

/** 广播给首页访客的一条 Agent 活动；`id` 是连接号，只用于列表去重。 */
export const SiteAgentActivitySchema = t.Object(
  {
    id: t.String({ minLength: 1, maxLength: 64 }),
    agentName: t.String({ minLength: 1, maxLength: 32 }),
    tool: t.String({ minLength: 1, maxLength: 64 }),
    kind: t.String({ minLength: 1, maxLength: 32 }),
    game: siteGameSchema,
    roomId: t.Optional(t.String({ maxLength: 32 })),
    page: t.Optional(t.String({ maxLength: 96 })),
    label: t.Optional(t.String({ maxLength: 48 })),
    at: t.Number(),
  },
  { additionalProperties: false }
);

export type SiteAgentActivity = Static<typeof SiteAgentActivitySchema>;

// ==================== 站点页面接管（人类页面交给 Agent 驱动） ====================

/**
 * 首页/大厅的「页面接管」：人类在设置里开启后，页面拿到一枚**配对码**，把它交给 Agent；
 * Agent 用远程 MCP 的 `control_page` 认领，之后由服务端向这台浏览器下发导航/点击指令。
 *
 * 凭据只有配对码：一次认领、短时效、绑在发起的那条连接上——页面刷新或断线即失效。
 * 页面自己不上报"我是 Agent"，也不接受任何未认领方下发的指令。
 */
export const SITE_PAGE_OPEN_COMMAND = "site.page.open";
export const SITE_PAGE_CLOSE_COMMAND = "site.page.close";
export const SITE_PAGE_STATE_COMMAND = "site.page.state";
export const SITE_PAGE_RESULT_COMMAND = "site.page.result";

export const SITE_PAGE_COMMAND_SET: ReadonlySet<string> = new Set([
  SITE_PAGE_OPEN_COMMAND,
  SITE_PAGE_CLOSE_COMMAND,
  SITE_PAGE_STATE_COMMAND,
  SITE_PAGE_RESULT_COMMAND,
]);

/** 页面上的一个可操作控件（`data-agent-control`），只带标识与人类可读标签。 */
export const SitePageControlSchema = t.Object(
  {
    id: t.String({ minLength: 1, maxLength: 96 }),
    label: t.String({ maxLength: 48 }),
  },
  { additionalProperties: false }
);

/**
 * 页面自报的可操作面：当前路径、标题与可见控件。
 * **不带输入框内容、聊天正文或任何私有数据**——Agent 据此决定下一步，而不是抓取页面。
 */
export const SitePageStateSchema = t.Object(
  {
    path: t.String({ minLength: 1, maxLength: 96 }),
    title: t.String({ maxLength: 64 }),
    controls: t.Array(SitePageControlSchema, { maxItems: 32 }),
    game: siteGameSchema,
    roomId: t.Optional(t.String({ maxLength: 32 })),
  },
  { additionalProperties: false }
);

export type SitePageState = Static<typeof SitePageStateSchema>;

/** 服务端下发给页面的指令；`navigate` 只接受站点地图里的路径，`click` 只接受已上报的控件 id。 */
export const SitePageCommandSchema = t.Object(
  {
    id: t.String({ minLength: 1, maxLength: 64 }),
    action: t.Union([t.Literal("navigate"), t.Literal("click")]),
    path: t.Optional(t.String({ maxLength: 96 })),
    control: t.Optional(t.String({ maxLength: 96 })),
  },
  { additionalProperties: false }
);

export type SitePageCommand = Static<typeof SitePageCommandSchema>;

/** 页面执行结果：失败原因只回给服务端与发起指令的那条 Agent 会话。 */
export const SitePageResultSchema = t.Object(
  {
    id: t.String({ minLength: 1, maxLength: 64 }),
    ok: t.Boolean(),
    error: t.Optional(t.String({ maxLength: 120 })),
  },
  { additionalProperties: false }
);

export type SitePageResult = Static<typeof SitePageResultSchema>;

export const SITE_PAGE_COMMAND_EVENT = "site.page.command";
export const SITE_PAGE_LEASE_EVENT = "site.page.lease";
