import type { AgentGameClient, GameId } from "../src/mcp/GameClient";
import type { SongClipAudio, SongClipPort, SongClipRequest } from "../src/mcp/audio/SongClip";
import { SeatUi } from "../src/mcp/ui/SeatUi";

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
  /** 猜歌片段音频的假端口；缺省不带，「播放片段」会明确失败。 */
  songClips?: SongClipPort;
}) => {
  const { game, snapshot, privateState, handler, songClips } = options;
  const calls: SentCall[] = [];
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
    stateVersion: () => version,
    waitForStateChange: async () => true,
    requestSync: async () => ({ synced: true }),
    ...(songClips ? { songClips } : {}),
  } as unknown as AgentGameClient;
  const ui = new SeatUi(client, { pacing: false });
  (client as unknown as { ui: SeatUi }).ui = ui;
  return { client, ui, calls };
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

/** 假的片段端口：记下每次请求与作废，返回固定的几个字节。 */
export const fakeSongClips = (
  overrides: Partial<SongClipAudio> = {},
  options: { fail?: Error } = {}
) => {
  const loads: SongClipRequest[] = [];
  const port: SongClipPort = {
    load: async (request) => {
      loads.push(request);
      if (options.fail) throw options.fail;
      return {
        mimeType: "audio/mpeg",
        format: "mp3",
        data: new Uint8Array([0xff, 0xfb, 0x90, 0x00, 1, 2, 3]),
        startTime: request.startTime,
        endTime: request.endTime,
        truncated: false,
        clipped: false,
        ...overrides,
      };
    },
  };
  return { port, loads };
};
