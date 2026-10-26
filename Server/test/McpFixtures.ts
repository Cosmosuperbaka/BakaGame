import type { AgentGameClient, GameId } from "../src/mcp/GameClient";
import { SeatUi } from "../src/mcp/ui/SeatUi";
import type { AgentFocusInput } from "../src/shared/AgentActivity";

export interface SentCall {
  game: string;
  type: string;
  payload: Record<string, unknown>;
}

export const baseFakerSnapshot = (phase = "waiting") => ({
  roomId: "1234",
  name: "测试房",
  phase,
  hostPlayerId: "p1",
  testMode: false,
  allowSpectators: true,
  settings: {
    roleConfig: { undercoverCount: 1, hasAngel: false, hasBlank: false },
    allowAgents: true,
  },
  roleLimits: { maxUndercoverCount: 2, canEnableAngel: false, canEnableBlank: false },
  status: { phase, started: false, day: 1 },
  players: [
    {
      id: "p1",
      name: "测试员",
      score: 0,
      membership: "active",
      online: true,
      isReady: false,
      isBot: false,
      isHost: true,
      roundStatus: "waiting",
    },
    {
      id: "p2",
      name: "对手",
      score: 0,
      membership: "active",
      online: true,
      isReady: true,
      isBot: false,
      isHost: false,
      roundStatus: "waiting",
    },
  ],
  descriptions: [],
  chat: [],
});

/**
 * 界面层的假客户端：只实现 SeatUi 用到的端口，命令与焦点都留在原地供断言。
 * `pacing: false` 关掉拟人延迟，用例按真实控件路径跑，不等人工节拍。
 */
export const mcpFixture = (options: {
  game: GameId;
  snapshot: Record<string, unknown>;
  privateState: Record<string, unknown>;
  handler?: (type: string, payload: Record<string, unknown>) => unknown;
}) => {
  const { game, snapshot, privateState, handler } = options;
  const calls: SentCall[] = [];
  const focus: AgentFocusInput[] = [];
  let version = 0;
  const client = {
    name: "TestAgent",
    siteOrigin: "http://127.0.0.1:4850",
    currentRoom: (target: string) => (target === game ? String(snapshot.roomId) : undefined),
    currentPlayerId: () => String(privateState.playerId),
    currentSnapshot: () => snapshot,
    currentPrivateState: () => privateState,
    sendInRoom: async (target: string, type: string, payload: Record<string, unknown> = {}) => {
      calls.push({ game: target, type, payload });
      version += 1;
      return handler ? handler(type, payload) : { ok: true };
    },
    publishAgentFocus: async (input: AgentFocusInput) => {
      focus.push(input);
    },
    stateVersion: () => version,
    waitForStateChange: async () => true,
    requestSync: async () => ({ synced: true }),
  } as unknown as AgentGameClient;
  const ui = new SeatUi(client, { pacing: false });
  (client as unknown as { ui: SeatUi }).ui = ui;
  return { client, ui, calls, focus };
};

/** 取某条已发命令的载荷；没有发出时直接失败，避免用 undefined 继续断言。 */
export const payloadOf = (calls: SentCall[], type: string): Record<string, unknown> => {
  const found = calls.find((call) => call.type === type);
  if (!found) throw new Error(`未发出命令 ${type}：${calls.map((call) => call.type).join(", ")}`);
  return found.payload;
};

/** 取某条命令最后一次发出的载荷，用于同一命令被多次触发的场景。 */
export const lastPayloadOf = (calls: SentCall[], type: string): Record<string, unknown> => {
  const found = [...calls].reverse().find((call) => call.type === type);
  if (!found) throw new Error(`未发出命令 ${type}：${calls.map((call) => call.type).join(", ")}`);
  return found.payload;
};

export const typesOf = (calls: SentCall[]): string[] => calls.map((call) => call.type);

export const idsOf = (controls: Array<{ id: string }>): string[] => controls.map((c) => c.id);
