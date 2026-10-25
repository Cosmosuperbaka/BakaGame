import type { AgentFocusKind } from "../shared/AgentActivity";
import { GAME_IDS, type AgentGameClient, type GameId } from "./GameClient";

export interface ToolFocus {
  game?: GameId;
  action?: string;
  kind: AgentFocusKind;
  targetId?: string;
}

const focusGame = (client: AgentGameClient, args: Record<string, unknown>): GameId | undefined => {
  if (typeof args.game === "string" && GAME_IDS.includes(args.game as GameId))
    return args.game as GameId;
  const joined = GAME_IDS.filter((game) => client.currentRoom(game));
  return joined.length === 1 ? joined[0] : undefined;
};

/**
 * 只给「进房/大厅」这类没有控件可指的导航动作留一个粗焦点。
 * 局内操作全部由 `ui_run` 按控件上报，浏览器页面上框住的就是实际控件。
 */
export function focusForTool(
  tool: string,
  args: Record<string, unknown>,
  client: AgentGameClient
): ToolFocus | undefined {
  const game = focusGame(client, args);
  switch (tool) {
    case "list_rooms":
      return args.game ? { game, kind: "lobby" } : undefined;
    case "create_room":
    case "join_room":
    case "claim_seat":
      return { game, kind: "enter_room" };
    default:
      return undefined;
  }
}

/** 进房类工具在完成后还要再报一次：房内页面在调用前收不到（此时还没绑定房间）。 */
export const FOCUS_AFTER_TOOLS = new Set([
  "list_rooms",
  "create_room",
  "join_room",
  "claim_seat",
]);

export async function publishToolFocus(
  client: AgentGameClient,
  agentName: string,
  tool: string,
  args: Record<string, unknown>
): Promise<void> {
  const focus = focusForTool(tool, args, client);
  if (!focus) return;
  await client.publishAgentFocus(
    {
      agentName: agentName.slice(0, 32),
      tool,
      kind: focus.kind,
      ...(focus.action ? { action: focus.action } : {}),
      ...(focus.targetId ? { targetId: focus.targetId } : {}),
    },
    focus.game
  );
}
