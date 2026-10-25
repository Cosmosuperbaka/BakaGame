import type { AgentGameClient, GameId } from "./GameClient";
import { GAME_IDS } from "./GameClient";
import { MCP_POLICY } from "./Policy";
import type { UiStep } from "./ui/Types";

export interface ToolContext {
  client: AgentGameClient;
  agentName: string;
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
      session: {
        type: "string",
        description:
          "远程 MCP 的 Agent 会话句柄；create_room / join_room 的返回值里带。支持 Mcp-Session-Id 的客户端可省略。",
      },
    },
  };
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  Boolean(value) && typeof value === "object" && !Array.isArray(value);

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

const summarizeRoom = (game: GameId, value: unknown) => {
  if (!isRecord(value)) return { game };
  return {
    game,
    roomId: value.roomId,
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
    name: "list_rooms",
    description: "列出房间（只读）。不传 game 时同时查询三款游戏。",
    inputSchema: gameSchema(false),
    handler: async (args, { client }) => {
      const games = args.game === undefined ? GAME_IDS : [asGame(args.game)];
      const results = [];
      for (const game of games) {
        const rooms = await client.listRooms(game);
        results.push({ game, rooms: rooms.map((room) => summarizeRoom(game, room)) });
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
];
