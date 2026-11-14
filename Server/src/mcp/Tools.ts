import type { AgentGameClient, GameId } from "./GameClient";
import { GAME_IDS } from "./GameClient";
import { MCP_POLICY } from "./Policy";
import {
  absolutePageUrl,
  findSitePage,
  gamePathOf,
  isAboutsPage,
  roomPageOf,
  SITE_PAGES,
} from "./SiteMap";
import type { UiStep } from "./ui/Types";
import { isRecord } from "../shared/Json";
import type { SitePageResult, SitePageStep } from "../shared/AgentActivity";
import {
  SITE_PAGE_ACTIONS,
  SITE_PAGE_KEYS,
  SITE_PAGE_SCROLLS,
  type SitePageEndReason,
} from "../shared/AgentPages";

/**
 * 标签页接管端口：由传输层实现（`SitePages`），工具只依赖这个窄接口。
 * stdio 入口没有它——那里没有可接管的浏览器标签页，工具会给出明确错误。
 */
export interface PageControlPort {
  claim(code: string, controllerId: string, agentName: string): PageLease;
  dispatch(controllerId: string, step: SitePageStep): Promise<SitePageResult>;
  isControlling(controllerId: string): boolean;
  closeByController(controllerId: string, reason?: SitePageEndReason): boolean;
}

interface PageLease {
  pageId: string;
  agentName: string;
}

export interface ToolContext {
  client: AgentGameClient;
  agentName: string;
  /** 站内远程 MCP 的会话号：标签页接管靠它绑定「哪个 Agent 在驱动这张标签页」。 */
  controllerId?: string;
  pages?: PageControlPort;
}

export interface McpTool {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  /** 写操作参与按房间限流与审计。 */
  write?: boolean;
  handler: (args: Record<string, unknown>, context: ToolContext) => Promise<unknown>;
}

/**
 * 远程 MCP 是无状态 HTTP：Agent 会话句柄既可走 `Mcp-Session-Id`，也可作为工具参数回传。
 * stdio 客户端不需要它，工具实现本身也从不读取。
 */
export const withRemoteSessionSchema = (
  schema: Record<string, unknown>
): Record<string, unknown> => {
  const properties = isRecord(schema.properties) ? schema.properties : {};
  return {
    ...schema,
    properties: {
      ...properties,
      agentName: {
        type: "string",
        maxLength: 32,
        description: "站点首页显示的 Agent 名称；只在新建会话时生效。",
      },
      session: {
        type: "string",
        description:
          "远程 MCP 的 Agent 会话句柄；任意工具调用的返回值里都带。支持 Mcp-Session-Id 的客户端可省略。",
      },
    },
  };
};

const objectSchema = (
  properties: Record<string, unknown>,
  required: string[] = []
): Record<string, unknown> => ({
  type: "object",
  properties,
  ...(required.length ? { required } : {}),
  additionalProperties: false,
});

const gameProperty = {
  type: "string",
  enum: [...GAME_IDS],
  description: "游戏：faker（谁是卧底）、song（猜歌）、cee（猜角色）",
};

const policyNotice = `\n\n使用边界：${MCP_POLICY}`;

const gameSchema = (required = false) =>
  objectSchema(
    {
      game: gameProperty,
    },
    required ? ["game"] : []
  );

const asGame = (value: unknown): GameId => {
  if (typeof value !== "string" || !GAME_IDS.includes(value as GameId)) {
    throw new Error(`game 必须是 ${GAME_IDS.join(" / ")} 之一`);
  }
  return value as GameId;
};

const needString = (args: Record<string, unknown>, key: string): string => {
  const value = args[key];
  if (typeof value !== "string" || !value.trim()) throw new Error(`缺少参数 ${key}`);
  return value.trim();
};

const optionalString = (args: Record<string, unknown>, key: string): string | undefined =>
  typeof args[key] === "string" && args[key].trim() ? args[key].trim() : undefined;

/**
 * 标签页接管必须由站内远程 MCP 发起：stdio 进程没有可绑定的浏览器连接，
 * 也不能证明自己持有页面的配对码。
 */
const requirePageControl = (
  context: ToolContext
): { pages: PageControlPort; controllerId: string } => {
  if (!context.pages || !context.controllerId)
    throw Object.assign(new Error("页面接管只能经站内远程 MCP（/api/mcp）使用"), {
      code: "PAGE_CONTROL_UNAVAILABLE",
    });
  return { pages: context.pages, controllerId: context.controllerId };
};

/**
 * Agent 自有座位与标签页接管互斥：接管期间局内一律走真实页面，
 * 否则同一个 Agent 既占人类的座位又占自己的座位，还能绕开页面直接发命令。
 */
const seatTool = (tool: McpTool): McpTool => ({
  ...tool,
  handler: async (args, context) => {
    if (context.controllerId && context.pages?.isControlling(context.controllerId))
      throw Object.assign(new Error("正在接管页面：请用 page_state / page_act 操作页面"), {
        code: "PAGE_CONTROL_ACTIVE",
      });
    return tool.handler(args, context);
  },
});

const summarizeRoom = (game: GameId, value: unknown) => {
  if (!isRecord(value)) return { game };
  const roomId = typeof value.roomId === "string" ? value.roomId : undefined;
  return {
    game,
    roomId: value.roomId,
    /** 页面内位置：Agent 需要能把「我在哪个房间」原样转给人类。 */
    page: roomId ? roomPageOf(game, roomId) : undefined,
    name: value.name,
    phase: value.phase,
    playerCount:
      typeof value.playerCount === "number"
        ? value.playerCount
        : Array.isArray(value.players)
          ? value.players.length
          : undefined,
    visibility: value.visibility,
    allowSpectators: value.allowSpectators,
    allowAgents: value.allowAgents === true,
    /** 只有开启 MCP 的房间能由 Agent 加入；密码房需要密码，但仍可加入。 */
    joinable: value.allowAgents === true,
    hasPassword: value.hasPassword,
    solo: value.solo,
    source: value.source,
  };
};

const activeGame = (args: Record<string, unknown>, client: AgentGameClient): GameId => {
  if (args.game !== undefined) {
    const game = asGame(args.game);
    if (!client.currentRoom(game)) throw new Error(`尚未加入 ${game} 的房间`);
    return game;
  }
  const joined = GAME_IDS.filter((game) => client.currentRoom(game));
  if (joined.length === 1) return joined[0]!;
  if (joined.length === 0) throw new Error("尚未加入任何房间；先用 join_room 加入");
  throw new Error(`同时加入了多个房间（${joined.join(", ")}），请指定 game`);
};

const pageStepProperties = {
  action: { type: "string", enum: SITE_PAGE_ACTIONS.filter((action) => action !== "read") },
  path: { type: "string", description: "navigate 的站内路径，例如 /cee 或 /cee/room/1234" },
  control: { type: "string", description: "控件 id，取自 view.controls；type 与 press 可省略" },
  text: { type: "string", maxLength: 400, description: "type 要输入的内容" },
  replace: { type: "boolean", description: "type 时先清空原内容" },
  key: { type: "string", enum: [...SITE_PAGE_KEYS], description: "press 的按键" },
  value: { type: "string", description: "select 的取值：选项标签或值" },
  direction: { type: "string", enum: [...SITE_PAGE_SCROLLS], description: "scroll 的方向" },
};

/** 只取一步操作的已知字段：远程会话句柄等工具级参数不进页面指令。 */
const pageStepOf = (raw: unknown, withView: boolean): SitePageStep => {
  if (!isRecord(raw)) throw new Error("每一步都必须是对象");
  const action = raw.action;
  if (action === "read" || !SITE_PAGE_ACTIONS.includes(action as SitePageStep["action"]))
    throw new Error(`action 只能是 ${pageStepProperties.action.enum.join(" / ")}`);
  const step: SitePageStep = { action: action as SitePageStep["action"], withView };
  if (typeof raw.path === "string") step.path = raw.path;
  if (typeof raw.control === "string") step.control = raw.control;
  if (typeof raw.text === "string") step.text = raw.text;
  if (typeof raw.replace === "boolean") step.replace = raw.replace;
  if (typeof raw.key === "string") step.key = raw.key as SitePageStep["key"];
  if (typeof raw.value === "string") step.value = raw.value;
  if (typeof raw.direction === "string")
    step.direction = raw.direction as SitePageStep["direction"];
  return step;
};

const uiStepSchema = {
  type: "object",
  properties: {
    action: {
      type: "string",
      enum: ["focus", "type", "press", "click", "set"],
      description:
        "focus 选中控件；type 向已选中的输入框逐字输入；press 在已选中的控件上按键；click 点击控件；set 设置开关/下拉/滑杆的取值",
    },
    control: {
      type: "string",
      description: "控件 id；type 与 press 省略时使用当前焦点控件",
    },
    text: { type: "string", description: "type 要输入的内容" },
    key: { type: "string", enum: ["Enter", "Escape"], description: "press 的按键" },
    value: { description: "set 的新取值：开关用布尔、下拉用字符串、滑杆用对象" },
    replace: { type: "boolean", description: "type 时先清空原内容再输入" },
  },
  required: ["action"],
  additionalProperties: false,
} as const;

export const TOOLS: McpTool[] = [
  {
    name: "get_site_map",
    description:
      "站点地图（只读）：列出人类可达的全部位置（三款游戏大厅、单人练习、关于项目、状态页）与用途。" +
      "不知道从哪里开始时先调它，再用 visit_page 定位。",
    inputSchema: objectSchema({}),
    handler: async (_args, { client }) => ({
      origin: client.siteOrigin,
      pages: SITE_PAGES.map((page) => ({
        ...page,
        url: absolutePageUrl(client.siteOrigin, page),
      })),
    }),
  },
  {
    name: "visit_page",
    description:
      "把 Agent 的位置移动到某个站点页面（与人类打开同一个链接等价），并返回该页的用途与绝对链接。" +
      "游戏大厅之后用 list_rooms 看房间、create_room 建房或 join_room 入房。" +
      policyNotice,
    inputSchema: objectSchema(
      {
        path: {
          type: "string",
          description: "页面路径，取自 get_site_map，例如 /abouts 或 /cee",
        },
        tab: {
          type: "string",
          description: "仅 /abouts：credits / changelog / commits / privacy / terms",
        },
      },
      ["path"]
    ),
    handler: async (args, { client }) => {
      const path = needString(args, "path");
      const page = findSitePage(path);
      if (!page) throw new Error(`未知页面：${path}；先调用 get_site_map 查看可用路径`);
      const tab = optionalString(args, "tab");
      if (tab && !(page.tabs ?? []).includes(tab))
        throw new Error(`该页没有 ${tab} 标签；可用：${(page.tabs ?? []).join(" / ") || "无"}`);
      return {
        path: page.path,
        title: page.title,
        description: page.description,
        access: page.access,
        ...(tab ? { tab } : {}),
        url: absolutePageUrl(client.siteOrigin, page, tab),
        next:
          isAboutsPage(page.path) || page.path === "/status"
            ? "这是只读页面；回到 get_site_map 选择游戏大厅"
            : "先 list_rooms 查看可从外部加入的房间，或 create_room 自己建房",
      };
    },
  },
  {
    name: "list_rooms",
    description:
      "列出房间（只读）。不传 game 时同时查询三款游戏。`joinable` 为 true 的房间才允许 Agent 加入。",
    inputSchema: gameSchema(false),
    handler: async (args, { client }) => {
      const games = args.game === undefined ? GAME_IDS : [asGame(args.game)];
      const results = [];
      for (const game of games) {
        const rooms = await client.listRooms(game);
        results.push({
          game,
          lobby: absolutePageUrl(client.siteOrigin, findSitePage(gamePathOf(game))!),
          rooms: rooms.map((room) => summarizeRoom(game, room)),
        });
      }
      return { games: results };
    },
  },
  seatTool({
    name: "create_room",
    description:
      "创建并加入一个房间（Agent 作为房主）。MCP 建房默认允许其他 Agent 加入；显式 allowAgents:false 才会关闭。song 可建 solo 房；faker 可传 roleConfig 配置卧底/天使/白板。" +
      policyNotice,
    inputSchema: objectSchema(
      {
        game: gameProperty,
        roomId: { type: "string" },
        name: { type: "string", maxLength: 40 },
        userName: { type: "string", description: "房主昵称，缺省用 MCP_AGENT_NAME" },
        visibility: { type: "string", enum: ["public", "private"] },
        allowSpectators: { type: "boolean" },
        allowAgents: { type: "boolean", description: "缺省 true；显式 false 关闭 Agent 接入" },
        password: { type: "string" },
        solo: { type: "boolean", description: "仅 song：单人练习房，自动出题" },
        roleConfig: {
          type: "object",
          description: "仅 faker：卧底/天使/白板数量与随机角色开关；缺省用服务端默认 1 卧底",
          properties: {
            undercoverCount: { type: "number" },
            angelCount: { type: "number" },
            blankCount: { type: "number" },
          },
          additionalProperties: false,
        },
      },
      ["game", "roomId", "name"]
    ),
    write: true,
    handler: async (args, { client, agentName }) => {
      const game = asGame(args.game);
      const result = await client.create(game, needString(args, "roomId"), {
        name: needString(args, "name"),
        userName: optionalString(args, "userName") ?? agentName,
        visibility: args.visibility === "private" ? "private" : "public",
        allowSpectators: args.allowSpectators !== false,
        allowAgents: args.allowAgents !== false,
        ...(game === "song" && args.solo === true ? { solo: true } : {}),
        ...(game === "faker" && isRecord(args.roleConfig) ? { roleConfig: args.roleConfig } : {}),
        ...(optionalString(args, "password") ? { password: optionalString(args, "password") } : {}),
      });
      return {
        game,
        roomId: result.roomId,
        page: roomPageOf(game, result.roomId),
        playerId: result.playerId,
        isAgent: true,
        allowAgents: args.allowAgents !== false,
        screen: await client.ui.screen(game),
      };
    },
  }),
  seatTool({
    name: "join_room",
    description:
      "以 Agent 身份加入房间。房间未开启 MCP（allowAgents != true）时返回 AGENTS_NOT_ALLOWED；先 list_rooms 看 allowAgents。" +
      policyNotice,
    inputSchema: objectSchema(
      {
        game: gameProperty,
        roomId: { type: "string" },
        name: { type: "string", description: "房内昵称，缺省用 MCP_AGENT_NAME" },
        password: { type: "string" },
      },
      ["game", "roomId"]
    ),
    write: true,
    handler: async (args, { client, agentName }) => {
      const game = asGame(args.game);
      const roomId = needString(args, "roomId");
      const password = optionalString(args, "password");
      const result = await client.join(game, roomId, {
        name: optionalString(args, "name") ?? agentName,
        ...(password ? { password } : {}),
      });
      return {
        game,
        roomId: result.roomId,
        page: roomPageOf(game, result.roomId),
        playerId: result.playerId,
        isAgent: true,
        screen: await client.ui.screen(game),
      };
    },
  }),
  seatTool({
    name: "leave_room",
    description: "离开当前游戏的房间。",
    inputSchema: gameSchema(true),
    write: true,
    handler: async (args, { client }) => {
      const game = asGame(args.game);
      return { game, left: await client.leave(game) };
    },
  }),
  seatTool({
    name: "get_screen",
    description:
      "读取当前游戏界面（与人类玩家页面一致）：阶段标题、玩家栏、聊天栏、可见面板、可操作控件。控件用 id 标识，操作前先看这里。" +
      policyNotice,
    inputSchema: objectSchema({
      game: gameProperty,
      refresh: {
        type: "boolean",
        description: "true 时先向服务端请求一次状态同步，再返回屏幕",
      },
    }),
    handler: async (args, { client }) => {
      const game = activeGame(args, client);
      if (args.refresh === true) await client.requestSync(game);
      return { game, screen: await client.ui.screen(game) };
    },
  }),
  seatTool({
    name: "ui_run",
    description:
      "像人类一样操作界面：按顺序串行执行多个步骤，并以人类速度回放。输入前必须先 focus 输入框（type 只能作用于当前焦点），再逐字输入；点结果或按钮用 click。每次操作后返回步骤结果与最新屏幕，屏幕里始终同步玩家栏、聊天栏和可见面板。" +
      policyNotice,
    inputSchema: objectSchema(
      {
        game: gameProperty,
        steps: {
          type: "array",
          minItems: 1,
          maxItems: 16,
          items: uiStepSchema,
        },
      },
      ["steps"]
    ),
    write: true,
    handler: async (args, { client }) => {
      const game = activeGame(args, client);
      if (!Array.isArray(args.steps)) throw new Error("steps 必须是数组");
      return client.ui.run(game, args.steps as UiStep[]);
    },
  }),
  {
    name: "get_mcp_policy",
    description: "读取本 MCP 的使用边界（只读）。",
    inputSchema: objectSchema({}),
    handler: async () => ({ policy: MCP_POLICY }),
  },
  {
    name: "control_page",
    description:
      "接管人类的一张标签页（任意页面，含房间内）。人类在设置的「MCP 连接」里开启后会得到 8 位配对码，" +
      "把它交给你后调这个工具。配对码一次有效、5 分钟内不用即过期，认领后人类只能旁观并随时收回。" +
      "接管后用 page_state 看页面、page_act 操作控件；游戏房间也走这一套，座位就是这张标签页本来的座位。" +
      "房间未开启 MCP 时认领会被拒绝。" +
      policyNotice,
    inputSchema: objectSchema(
      {
        code: { type: "string", description: "8 位配对码，由页面设置生成并交给你的" },
      },
      ["code"]
    ),
    write: true,
    handler: async (args, context) => {
      const { pages, controllerId } = requirePageControl(context);
      if (GAME_IDS.some((game) => context.client.currentRoom(game)))
        throw Object.assign(new Error("已经坐在自己的座位上：先 leave_room 再接管页面"), {
          code: "PAGE_CONTROL_SEATED",
        });
      const lease = pages.claim(needString(args, "code"), controllerId, context.agentName);
      const { view } = await pages.dispatch(controllerId, { action: "read" });
      return { pageId: lease.pageId, agentName: lease.agentName, view };
    },
  },
  {
    name: "page_state",
    description:
      "查看被接管页面此刻的样子：路径、人类可见的文字（lines 在视口内，offscreenLines 要滚动才看得到）、" +
      "可操作控件（id、角色、标签、当前值、状态）与当前弹窗。看到的和人类一样：隐藏内容、" +
      "别人的私有信息、账号与登录相关区域都不在其中。页面不可达时 restricted 为 true 且正文为空。",
    inputSchema: objectSchema({}),
    handler: async (_args, context) => {
      const { pages, controllerId } = requirePageControl(context);
      const result = await pages.dispatch(controllerId, { action: "read" });
      if (!result.ok)
        throw Object.assign(new Error(result.error ?? "读取页面失败"), { code: "PAGE_FAILED" });
      return { view: result.view };
    },
  },
  {
    name: "page_act",
    description:
      "在被接管的页面上像人类一样操作，焦点会先移到控件上再动手，走与人类相同的处理函数和校验。" +
      "可传单步字段，也可传 steps 串行执行（失败即停）。返回每步结果与最新页面。" +
      "动作：navigate 打开站内路径；click 点击控件；focus 聚焦控件；type 向控件或当前焦点逐字输入" +
      "（replace 先清空）；press 按键；select 选中下拉或滑杆的取值；scroll 滚动页面或把控件滚入视野。" +
      "下拉、弹窗的选项在点击后才出现，点开后看返回的 view 再点选项。" +
      policyNotice,
    inputSchema: objectSchema({
      ...pageStepProperties,
      steps: {
        type: "array",
        minItems: 1,
        maxItems: 8,
        items: {
          type: "object",
          properties: pageStepProperties,
          required: ["action"],
          additionalProperties: false,
        },
      },
    }),
    write: true,
    handler: async (args, context) => {
      const { pages, controllerId } = requirePageControl(context);
      const steps = Array.isArray(args.steps) ? args.steps : [args];
      if (steps.length === 0 || steps.length > 8) throw new Error("steps 需要 1 到 8 步");
      const results: Array<{ action: unknown; ok: boolean; error?: string }> = [];
      let view: unknown;
      for (const [index, raw] of steps.entries()) {
        const step = pageStepOf(raw, index === steps.length - 1);
        const result = await pages.dispatch(controllerId, step);
        results.push({
          action: step.action,
          ok: result.ok,
          ...(result.error ? { error: result.error } : {}),
        });
        view = result.view ?? view;
        if (!result.ok) return { ok: false, steps: results, view };
      }
      return { ok: true, steps: results, view };
    },
  },
  {
    name: "release_page",
    description: "交还页面控制权，人类立刻恢复手动操作。",
    inputSchema: objectSchema({}),
    handler: async (_args, context) => {
      const { pages, controllerId } = requirePageControl(context);
      return { released: pages.closeByController(controllerId, "released") };
    },
  },
];
