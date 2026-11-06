import { Type as t, type Static } from "@sinclair/typebox";
import type { SitePageAction, SitePageEndReason, SitePageKey, SitePageScroll } from "./AgentPages";

export const AGENT_FOCUS_KINDS = ["site", "lobby", "enter_room", "state", "action"] as const;

export type AgentFocusKind = (typeof AGENT_FOCUS_KINDS)[number];

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
 * Agent 上报的站点级焦点。字段是**封闭集合**：控件焦点与逐字输入进度不进这条通道，
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

// ==================== 标签页接管（人类页面交给 Agent 驱动） ====================

/**
 * 任意页面的「标签页接管」：人类在设置里开启后拿到一枚**配对码**，交给 Agent；
 * Agent 用远程 MCP 的 `control_page` 认领，之后由服务端向这张标签页下发指令，
 * 指令在真实页面上执行，走的是人类同样的处理函数与校验。
 *
 * 配对码一次有效、短时效；认领后租约按标签页身份记账，刷新不用重新配对。
 * 页面不接受任何未认领方下发的指令，也不向 Agent 出示标签页身份。
 */
export const SITE_PAGE_OPEN_COMMAND = "site.page.open";
export const SITE_PAGE_CLOSE_COMMAND = "site.page.close";
export const SITE_PAGE_RESULT_COMMAND = "site.page.result";

export const SITE_PAGE_COMMAND_SET: ReadonlySet<string> = new Set([
  SITE_PAGE_OPEN_COMMAND,
  SITE_PAGE_CLOSE_COMMAND,
  SITE_PAGE_RESULT_COMMAND,
]);

const pageControlId = t.String({ pattern: "^[A-Za-z0-9_.:-]{1,96}$" });

/** 页面上一个人类能看到、能操作的控件；密码类输入框不带 `value`。 */
export const SitePageControlSchema = t.Object(
  {
    id: pageControlId,
    role: t.String({ maxLength: 24 }),
    label: t.String({ maxLength: 80 }),
    value: t.Optional(t.String({ maxLength: 400 })),
    options: t.Optional(t.Array(t.String({ maxLength: 80 }), { maxItems: 32 })),
    states: t.Optional(t.Array(t.String({ maxLength: 16 }), { maxItems: 8 })),
    inView: t.Boolean(),
  },
  { additionalProperties: false }
);

export type SitePageControl = Static<typeof SitePageControlSchema>;

/**
 * Agent 看到的页面：人类此刻能看到的文字、控件与状态。
 *
 * `lines` 在视口内，`offscreenLines` 已渲染但要滚动才看得到；隐藏节点、
 * 敏感区域与接管提示都不进来。`restricted` 表示当前页面不在 Agent 可达范围，正文一律为空。
 */
export const SitePageViewSchema = t.Object(
  {
    path: t.String({ minLength: 1, maxLength: 96 }),
    title: t.String({ maxLength: 64 }),
    game: siteGameSchema,
    roomId: t.Optional(t.String({ maxLength: 32 })),
    restricted: t.Optional(t.Boolean()),
    dialog: t.Optional(t.String({ maxLength: 80 })),
    focused: t.Optional(pageControlId),
    scroll: t.Object(
      { top: t.Number(), max: t.Number(), viewport: t.Number() },
      { additionalProperties: false }
    ),
    lines: t.Array(t.String({ maxLength: 400 }), { maxItems: 240 }),
    offscreenLines: t.Array(t.String({ maxLength: 400 }), { maxItems: 120 }),
    controls: t.Array(SitePageControlSchema, { maxItems: 120 }),
    truncated: t.Optional(t.Boolean()),
  },
  { additionalProperties: false }
);

export type SitePageView = Static<typeof SitePageViewSchema>;

/** Agent 请求的一步操作：动作的取值与范围由 `SitePages.dispatch` 校验。 */
export interface SitePageStep {
  action: SitePageAction;
  path?: string;
  control?: string;
  text?: string;
  replace?: boolean;
  key?: SitePageKey;
  value?: string;
  direction?: SitePageScroll;
  withView?: boolean;
}

/** 服务端下发给页面的指令。 */
export interface SitePageCommand extends SitePageStep {
  id: string;
}

/** 页面执行结果：失败原因只回给服务端与发起指令的那条 Agent 会话。 */
export const SitePageResultSchema = t.Object(
  {
    id: t.String({ minLength: 1, maxLength: 64 }),
    ok: t.Boolean(),
    error: t.Optional(t.String({ maxLength: 160 })),
    view: t.Optional(SitePageViewSchema),
  },
  { additionalProperties: false }
);

export type SitePageResult = Static<typeof SitePageResultSchema>;

/** 接管状态推给页面。`resumed` 表示刷新后续上同一份租约，`focusControl` 是刷新前的焦点控件。 */
export interface SitePageLease {
  controlled: boolean;
  agentName?: string;
  resumed?: boolean;
  focusControl?: string;
  reason?: SitePageEndReason;
}

export const SITE_PAGE_COMMAND_EVENT = "site.page.command";
export const SITE_PAGE_LEASE_EVENT = "site.page.lease";
