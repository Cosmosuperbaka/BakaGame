import { BANGUMI_USER_AGENT } from "../infrastructure/BangumiUserAgent";
import type { AgentGameClient, GameId } from "./GameClient";
import { GAME_IDS } from "./GameClient";

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

const needPlayerId = (args: Record<string, unknown>, key = "playerId") =>
  needString(args, key);

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

const roomState = (game: GameId, client: AgentGameClient, snapshot: Record<string, unknown>) => ({
  game,
  roomId: client.currentRoom(game),
  you: { playerId: client.currentPlayerId(game), isAgent: true },
  snapshot,
});

/** 只保留公开的结算字段：答案、私有身份与内部状态一律不返回。 */
const publicRecord = (game: GameId, snapshot: Record<string, unknown> | undefined) => {
  if (!snapshot) return { available: false, reason: "尚未加入房间或没有收到公开快照" };
  const players = Array.isArray(snapshot.players)
    ? snapshot.players.map((player) => {
        const row = isRecord(player) ? player : {};
        return {
          id: row.id,
          name: row.name,
          score: row.score,
          isAgent: row.isAgent === true,
        };
      })
    : [];
  if (game === "faker") {
    const phase = isRecord(snapshot.status) ? snapshot.status.phase : undefined;
    const summary = isRecord(snapshot.summary) ? snapshot.summary : undefined;
    return {
      available: phase === "gameOver",
      game,
      phase,
      players,
      result: summary
        ? {
            winner: summary.winner,
            reason: summary.reason,
            awardedScores: summary.awardedScores,
            revealedRoles: summary.revealedRoles,
          }
        : null,
    };
  }
  if (game === "song") {
    const finalScores = Array.isArray(snapshot.finalScores) ? snapshot.finalScores : null;
    const summary = isRecord(snapshot.roundSummary) ? snapshot.roundSummary : undefined;
    return {
      available: Boolean(finalScores),
      game,
      phase: snapshot.phase,
      players,
      finalScores,
      lastRound: summary
        ? {
            roundNumber: summary.roundNumber,
            submitterPlayerId: summary.submitterPlayerId,
            correctPlayerIds: summary.correctPlayerIds,
            scores: summary.scores,
          }
        : null,
    };
  }
  const summary = isRecord(snapshot.roundSummary) ? snapshot.roundSummary : undefined;
  return {
    available: snapshot.phase === "settled",
    game,
    phase: snapshot.phase,
    players,
    roundNumber: snapshot.roundNumber,
    result: summary
      ? {
          winners: summary.winners,
          scores: summary.scores,
        }
      : null,
  };
};

const CHAT_COMMAND: Record<GameId, string> = {
  faker: "chat.send",
  song: "song.chat.send",
  cee: "cee.chat.send",
};

const PLUS_ONE_COMMAND: Record<GameId, string> = {
  faker: "chat.plusOne",
  song: "song.chat.plusOne",
  cee: "cee.chat.plusOne",
};

const fakerAction = (action: string, args: Record<string, unknown>) => {
  switch (action) {
    case "ready":
      return { type: "player.setReady", payload: { ready: args.ready !== false } };
    case "start":
    case "advance":
      return { type: "game.advancePhase", payload: {} };
    case "assign_questioner":
      return { type: "game.assignQuestioner", payload: { playerId: needPlayerId(args) } };
    case "submit_words": {
      const words = args.words;
      if (!Array.isArray(words) || words.length !== 2 || words.some((word) => typeof word !== "string"))
        throw new Error("submit_words 需要 words 为两个字符串");
      return {
        type: "game.submitWords",
        payload: {
          words: [String(words[0]), String(words[1])],
          ...(optionalString(args, "blankHint") ? { blankHint: optionalString(args, "blankHint") } : {}),
        },
      };
    }
    case "describe":
      return { type: "game.submitDescription", payload: { text: needString(args, "text") } };
    case "vote":
      return { type: "game.submitVote", payload: { targetId: needString(args, "targetId") } };
    case "night_action":
      return {
        type: "game.submitNightAction",
        payload: { targetId: typeof args.targetId === "string" ? args.targetId : null },
      };
    case "blank_guess": {
      const words = args.words;
      if (!Array.isArray(words) || words.length !== 2)
        throw new Error("blank_guess 需要 words 为两个字符串");
      return {
        type: "game.submitBlankGuess",
        payload: { words: [String(words[0]), String(words[1])] },
      };
    }
    case "review_blank_guess":
      return { type: "game.reviewBlankGuess", payload: { approve: args.approve === true } };
    case "cancel_vote":
      return { type: "game.cancelVote", payload: {} };
    case "cancel_night_action":
      return { type: "game.cancelNightAction", payload: {} };
    case "stop_phase_timer":
      return { type: "game.stopPhaseTimer", payload: {} };
    default:
      throw new Error(`未知的 faker action：${action}`);
  }
};

const songAction = (action: string, args: Record<string, unknown>) => {
  switch (action) {
    case "ready":
      return { type: "song.player.setReady", payload: { ready: args.ready !== false } };
    case "start":
      return { type: "song.game.start", payload: {} };
    case "choose_submitter":
      return { type: "song.game.chooseSubmitter", payload: { playerId: needPlayerId(args) } };
    case "submit_song":
      return { type: "song.game.submitSong", payload: { songId: needString(args, "songId") } };
    case "submit_anime":
      return {
        type: "song.game.submitAnime",
        payload: {
          subjectId: needString(args, "subjectId"),
          ...(optionalString(args, "songId") ? { songId: optionalString(args, "songId") } : {}),
        },
      };
    case "guess_song":
      return { type: "song.game.guess", payload: { songId: needString(args, "songId") } };
    case "guess_anime":
      return { type: "song.game.guessAnime", payload: { subjectId: needString(args, "subjectId") } };
    case "give_up":
      return { type: "song.game.giveUp", payload: {} };
    case "skip_round":
      return { type: "song.game.skipRound", payload: {} };
    case "next_round":
      return { type: "song.game.nextRound", payload: {} };
    case "finish":
      return { type: "song.game.finish", payload: {} };
    case "audio_ready":
      return { type: "song.game.audioReady", payload: { roundNumber: needNumber(args, "roundNumber") } };
    case "audio_failed":
      return { type: "song.game.audioFailed", payload: { roundNumber: needNumber(args, "roundNumber") } };
    default:
      throw new Error(`未知的 song action：${action}`);
  }
};

const needNumber = (args: Record<string, unknown>, key: string): number => {
  const value = args[key];
  if (typeof value !== "number" || !Number.isFinite(value)) throw new Error(`缺少参数 ${key}`);
  return value;
};

const ceeAction = (action: string, args: Record<string, unknown>) => {
  switch (action) {
    case "ready":
      return { type: "cee.player.ready", payload: { ready: args.ready !== false } };
    case "start":
      return { type: "cee.game.start", payload: {} };
    case "choose_setter":
      return { type: "cee.game.chooseSetter", payload: { playerId: needPlayerId(args) } };
    case "set_answer":
      return {
        type: "cee.game.setAnswer",
        payload: {
          characterId: needNumber(args, "characterId"),
          hints: Array.isArray(args.hints) ? args.hints.map(String).slice(0, 3) : [],
        },
      };
    case "guess":
      return { type: "cee.game.guess", payload: { characterId: needNumber(args, "characterId") } };
    case "surrender":
      return { type: "cee.game.surrender", payload: {} };
    case "next":
      return { type: "cee.game.next", payload: {} };
    case "cancel":
      return { type: "cee.game.cancel", payload: {} };
    case "image_hint":
      return { type: "cee.game.imageHint", payload: {} };
    default:
      throw new Error(`未知的 cee action：${action}`);
  }
};

const actionSchema = objectSchema(
  {
    game: gameProperty,
    action: { type: "string" },
    playerId: { type: "string" },
    targetId: { type: "string" },
    text: { type: "string" },
    words: { type: "array", items: { type: "string" }, minItems: 2, maxItems: 2 },
    blankHint: { type: "string" },
    songId: { type: "string" },
    subjectId: { type: "string" },
    characterId: { type: "number" },
    hints: { type: "array", items: { type: "string" }, maxItems: 3 },
    roundNumber: { type: "number" },
    ready: { type: "boolean" },
    approve: { type: "boolean" },
  },
  ["action"]
);

const bangumiSearch = async (args: Record<string, unknown>): Promise<unknown> => {
  const keyword = needString(args, "keyword");
  const kind = args.kind === "character" ? "character" : "subject";
  const limit =
    typeof args.limit === "number" && Number.isFinite(args.limit)
      ? Math.min(Math.max(Math.trunc(args.limit), 1), 20)
      : 8;
  const endpoint =
    kind === "character"
      ? "https://api.bgm.tv/v0/search/characters"
      : "https://api.bgm.tv/v0/search/subjects";
  const body =
    kind === "character"
      ? { keyword, filter: { nsfw: false } }
      : { keyword, filter: { type: [2] } };
  const response = await fetch(`${endpoint}?limit=${limit}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json",
      "user-agent": BANGUMI_USER_AGENT,
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(8_000),
  });
  if (!response.ok) throw new Error(`Bangumi 搜索失败：HTTP ${response.status}`);
  const payload = (await response.json()) as unknown;
  const data = isRecord(payload) && Array.isArray(payload.data) ? payload.data : [];
  return {
    kind,
    results: data.slice(0, limit).map((entry) => {
      const row = isRecord(entry) ? entry : {};
      const images = isRecord(row.images) ? row.images : {};
      return {
        id: row.id,
        name: row.name,
        nameCn: row.name_cn,
        date: row.date,
        type: row.type,
        image:
          typeof images.grid === "string"
            ? images.grid
            : typeof images.medium === "string"
              ? images.medium
              : undefined,
      };
    }),
  };
};

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
      "创建并加入一个房间（Agent 作为房主）。allowAgents 缺省关闭；打开后其他 Agent 可加入。",
    inputSchema: objectSchema(
      {
        game: gameProperty,
        roomId: { type: "string" },
        name: { type: "string", maxLength: 40 },
        userName: { type: "string", description: "房主昵称，缺省用 MCP_AGENT_NAME" },
        visibility: { type: "string", enum: ["public", "private"] },
        allowSpectators: { type: "boolean" },
        allowAgents: { type: "boolean" },
        password: { type: "string" },
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
        allowAgents: args.allowAgents === true,
        ...(optionalString(args, "password") ? { password: optionalString(args, "password") } : {}),
      });
      return {
        game,
        roomId: result.roomId,
        playerId: result.playerId,
        isAgent: true,
        state: result.snapshot ? roomState(game, client, result.snapshot) : null,
      };
    },
  },
  {
    name: "join_room",
    description:
      "以 Agent 身份加入房间。房主关闭 allowAgents（默认）时会返回 AGENTS_NOT_ALLOWED。",
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
        state: result.snapshot ? roomState(game, client, result.snapshot) : null,
      };
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
    name: "get_room_state",
    description: "读取当前房间的公开快照（只读，不含答案与私有状态）。",
    inputSchema: gameSchema(false),
    handler: async (args, { client }) => {
      const game = activeGame(args, client);
      const snapshot = client.currentSnapshot(game);
      if (!snapshot) throw new Error("尚未收到房间公开快照");
      return roomState(game, client, snapshot);
    },
  },
  {
    name: "get_game_record",
    description: "读取当前房间的公开结算记录（只读，不含答案、词对与私有身份）。",
    inputSchema: gameSchema(false),
    handler: async (args, { client }) => {
      const game = activeGame(args, client);
      return publicRecord(game, client.currentSnapshot(game));
    },
  },
  {
    name: "send_chat",
    description: "在当前房间发送聊天消息。",
    inputSchema: objectSchema(
      {
        game: gameProperty,
        text: { type: "string", maxLength: 500 },
      },
      ["text"]
    ),
    write: true,
    handler: async (args, { client }) => {
      const game = activeGame(args, client);
      return client.sendInRoom(game, CHAT_COMMAND[game], { text: needString(args, "text") });
    },
  },
  {
    name: "plus_one",
    description: "给当前房间的一条聊天消息 +1 / 撤销 +1。",
    inputSchema: objectSchema(
      {
        game: gameProperty,
        messageId: { type: "string" },
      },
      ["messageId"]
    ),
    write: true,
    handler: async (args, { client }) => {
      const game = activeGame(args, client);
      return client.sendInRoom(game, PLUS_ONE_COMMAND[game], {
        messageId: needString(args, "messageId"),
      });
    },
  },
  {
    name: "faker_action",
    description:
      "谁是卧底操作：ready / start / assign_questioner / submit_words / describe / vote / night_action / blank_guess / review_blank_guess / cancel_vote / cancel_night_action / stop_phase_timer。",
    inputSchema: actionSchema,
    write: true,
    handler: async (args, { client }) =>
      client.sendInRoom("faker", ...toCommand(fakerAction(needString(args, "action"), args))),
  },
  {
    name: "song_action",
    description:
      "猜歌操作：ready / start / choose_submitter / submit_song / submit_anime / guess_song / guess_anime / give_up / skip_round / next_round / finish / audio_ready / audio_failed。",
    inputSchema: actionSchema,
    write: true,
    handler: async (args, { client }) => {
      const game = activeGame(args, client);
      if (game !== "song") throw new Error("song_action 只用于 song");
      return client.sendInRoom("song", ...toCommand(songAction(needString(args, "action"), args)));
    },
  },
  {
    name: "cee_action",
    description:
      "猜角色操作：ready / start / choose_setter / set_answer / guess / surrender / next / cancel / image_hint。",
    inputSchema: actionSchema,
    write: true,
    handler: async (args, { client }) => {
      const game = activeGame(args, client);
      if (game !== "cee") throw new Error("cee_action 只用于 cee");
      return client.sendInRoom("cee", ...toCommand(ceeAction(needString(args, "action"), args)));
    },
  },
  {
    name: "search_bangumi",
    description: "检索 Bangumi 番剧或角色（只读）；不接触当前对局答案。",
    inputSchema: objectSchema(
      {
        keyword: { type: "string" },
        kind: { type: "string", enum: ["subject", "character"] },
        limit: { type: "number" },
      },
      ["keyword"]
    ),
    handler: async (args) => bangumiSearch(args),
  },
];

const toCommand = (value: { type: string; payload: Record<string, unknown> }) =>
  [value.type, value.payload] as const;
