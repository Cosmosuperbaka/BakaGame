import type { AgentGameClient, GameId } from "./GameClient";
import { GAME_IDS } from "./GameClient";
import { MCP_POLICY } from "./Policy";
import { absolutePageUrl, findSitePage, gamePathOf, roomPageOf, SITE_PAGES } from "./SiteMap";
import type { UiStep } from "./ui/Types";
import { isRecord } from "../shared/Json";
import type { SitePageCommand, SitePageResult, SitePageState } from "../shared/AgentActivity";

/**
 * 页面接管端口：由传输层实现（`SitePages`），工具只依赖这个窄接口。
 * stdio 入口没有它——那里没有「站内浏览器页面」可接管，工具会给出明确错误。
 */
export interface PageControlPort {
  claim(
    code: string,
    controllerId: string,
    agentName: string
  ): { pageId: string; agentName: string; state: SitePageState };
  viewFor(
    controllerId: string
  ):
    | { pageId: string; agentName: string; state: SitePageState; lastResult?: SitePageResult }
    | undefined;
  dispatch(
    controllerId: string,
    action: "navigate" | "click",
    target: { path?: string; control?: string }
  ): SitePageCommand;
  closeByController(controllerId: string): boolean;
}

export interface ToolContext {
  client: AgentGameClient;
  agentName: string;
  /** 站内远程 MCP 的会话号：页面接管靠它绑定「哪个 Agent 在驱动这台浏览器」。 */
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
 * 页面接管必须由站内远程 MCP 发起：stdio 进程没有可绑定的浏览器连接，
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
          page.path === "/abouts" || page.path === "/status"
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
  {
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
  },
  {
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
  },
  {
    name: "claim_seat",
    description:
      "用房间的会话凭证认领座位：接手该玩家的座位并锁定其手动操作。认领后本连接就是该座位的唯一控制器。" +
      policyNotice,
    inputSchema: objectSchema(
      {
        game: gameProperty,
        roomId: { type: "string", description: "房间号" },
        sessionToken: { type: "string", description: "玩家在 MCP 设置里复制的会话凭证" },
      },
      ["game", "roomId", "sessionToken"]
    ),
    write: true,
    handler: async (args, { client }) => {
      const game = asGame(args.game);
      const result = await client.claimSeat(
        game,
        needString(args, "roomId"),
        needString(args, "sessionToken")
      );
      return {
        game,
        roomId: result.roomId,
        page: roomPageOf(game, result.roomId),
        playerId: result.playerId,
        isAgent: true,
        screen: await client.ui.screen(game),
      };
    },
  },
  {
    name: "release_seat",
    description: "释放当前 MCP 接管的座位，把控制权交还人类会话。" + policyNotice,
    inputSchema: gameSchema(false),
    write: true,
    handler: async (args, { client }) => {
      const game = activeGame(args, client);
      return client.sendInRoom(game, "mcp.release", {});
    },
  },
  {
    name: "leave_room",
    description: "离开当前游戏的房间。",
    inputSchema: gameSchema(true),
    write: true,
    handler: async (args, { client }) => {
      const game = asGame(args.game);
      return { game, left: await client.leave(game) };
    },
  },
  {
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
      return { game, screen: await client.ui.screen(game, { announce: true }) };
    },
  },
  {
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
  },
  {
    name: "get_mcp_policy",
    description: "读取本 MCP 的使用边界（只读）。",
    inputSchema: objectSchema({}),
    handler: async () => ({ policy: MCP_POLICY }),
  },
  {
    name: "control_page",
    description:
      "接管一张人类页面（首页或大厅），像接管座位一样用自己的会话驱动它。" +
      "人类在设置里点「允许 Agent 接管本页」会得到 8 位配对码，把它交给你后调这个工具。" +
      "配对码一次有效、5 分钟内不用即过期，页面刷新或断开也会作废。" +
      "接管成功后用 page_act 在这台浏览器里导航/点击，page_state 复查当前位置。",
    inputSchema: objectSchema(
      {
        code: { type: "string", description: "8 位配对码，由页面设置生成并交给你的" },
      },
      ["code"]
    ),
    write: true,
    handler: async (args, context) => {
      const { pages, controllerId } = requirePageControl(context);
      const lease = pages.claim(needString(args, "code"), controllerId, context.agentName);
      return {
        pageId: lease.pageId,
        agentName: lease.agentName,
        state: lease.state,
        next: '用 page_act({ action: "navigate", path: "/songuessr" }) 进入对应游戏大厅',
      };
    },
  },
  {
    name: "page_state",
    description:
      "读取已接管页面的当前状态（只读）：路径、标题、可点控件（`data-agent-control` 的 id 与标签），" +
      "以及上一条指令的执行结果。不包含输入框内容与聊天正文。",
    inputSchema: objectSchema({}),
    handler: async (_args, context) => {
      const { pages, controllerId } = requirePageControl(context);
      const view = pages.viewFor(controllerId);
      if (!view)
        throw Object.assign(new Error("尚未接管页面：先调 control_page"), {
          code: "PAGE_NOT_CONTROLLED",
        });
      return view;
    },
  },
  {
    name: "page_act",
    description:
      "在被接管的页面里执行一步：`navigate` 打开站点内的路径（只接受人类可达位置，含房间页），" +
      "`click` 点击页面当前上报的控件 id（先 page_state 看有哪些）。" +
      "指令异步执行，用 page_state 复查结果。",
    inputSchema: objectSchema(
      {
        action: { type: "string", enum: ["navigate", "click"] },
        path: {
          type: "string",
          description: "navigate 的目标路径，例如 /songuessr、/cee 或 /cee/room/1234",
        },
        control: { type: "string", description: "click 的控件 id，取自 page_state.controls" },
      },
      ["action"]
    ),
    write: true,
    handler: async (args, context) => {
      const { pages, controllerId } = requirePageControl(context);
      const action = needString(args, "action");
      if (action !== "navigate" && action !== "click")
        throw new Error("action 只能是 navigate 或 click");
      const command = pages.dispatch(controllerId, action, {
        ...(typeof args.path === "string" ? { path: args.path } : {}),
        ...(typeof args.control === "string" ? { control: args.control } : {}),
      });
      return { queued: command, next: "稍后用 page_state 确认页面已到新位置" };
    },
  },
  {
    name: "release_page",
    description: "交还页面控制权，让人类重新手动操作这台浏览器。",
    inputSchema: objectSchema({}),
    handler: async (_args, context) => {
      const { pages, controllerId } = requirePageControl(context);
      return { released: pages.closeByController(controllerId) };
    },
  },
];
