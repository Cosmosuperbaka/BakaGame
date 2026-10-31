import { expect, test } from "bun:test";
import { createServer, type Server as HttpServer } from "node:http";
import { createRequire } from "node:module";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { io as connect } from "socket.io-client";
import { CEEOriginalService } from "../src/application/CEEOriginalService";
import type { CEEDataProvider, CEERawCharacter } from "../src/infrastructure/CEEData";
import {
  createDefaultCEESettings,
  type CEECharacterView,
  type CEERoomEnterResult,
  type CEERoomClientMessage,
} from "../src/shared/CEE";

const originalRoot = resolve(import.meta.dir, "../../../anime-character-guessr/server");
const sourceAvailable = existsSync(resolve(originalRoot, "utils/socket.js"));
const LOCAL_AES_SECRET = "local-integration-secret";
const character = (id: number): CEECharacterView => ({
  id,
  name: `角色${id}`,
  nameCn: "",
  gender: "?",
  popularity: 1,
  summary: "本地联调题目",
  appearances: [],
  comparisonAppearances: [],
  extraTags: [],
  highestRating: -1,
  earliestAppearance: -1,
  latestAppearance: -1,
  subjectTags: ["校园"],
  characterTags: [],
  voiceActors: [],
  metaTags: ["校园"],
});
const data: CEEDataProvider = {
  async getCharacter(id) {
    return character(id);
  },
  async chooseRandomCharacter() {
    return character(900);
  },
  async getRawCharacter(id): Promise<CEERawCharacter> {
    return { ...character(id), aliases: [], appearances: [], extraTagsBySubject: {} };
  },
  async searchCharacters() {
    return [];
  },
  async searchSubjects() {
    return [];
  },
  async getSubjectCharacters() {
    return [];
  },
  async importDirectory(id) {
    return { id, subjectIds: [], missingSubjectIds: [], importedAt: 0 };
  },
  async resolveCharacterImage() {
    return undefined;
  },
  async getSubjects() {
    return [];
  },
  async resolveSubjectImage() {
    return undefined;
  },
  close() {},
};
/**
 * 这个文件只会被 `test:integration:cee` 显式点名运行（bun test 不收 `.integration.ts`），
 * 点名运行却缺原版源码时必须失败：跳过等于整份联调静默通过，看不出其实什么都没测。
 */
test("原版仓库源码就位", () => {
  if (!sourceAvailable)
    throw new Error(`缺少原版仓库源码：${originalRoot}，请先在同级目录检出后再运行联调`);
});

test.skipIf(!sourceAvailable)(
  "真实原版与增强客户端在本地同房同步猜测、聊天隔离和连续结算",
  async () => {
    const requireOriginal = createRequire(resolve(originalRoot, "package.json"));
    const { Server } = requireOriginal("socket.io") as {
      Server: new (
        server: HttpServer,
        options: { path: string }
      ) => { close(callback: () => void): void };
    };
    // 两端用同一把本地密钥：bun 会自动加载 .env，读那里的真实密钥只会让本地原版解不开答案。
    process.env.AES_SECRET = LOCAL_AES_SECRET;
    const setupSocket = requireOriginal("./utils/socket.js") as (
      io: unknown,
      rooms: Map<string, unknown>
    ) => void;
    const rooms = new Map<string, unknown>();
    const http = createServer((_request, response) => {
      response.setHeader("content-type", "application/json");
      response.end(
        JSON.stringify([...rooms.keys()].map((id) => ({ id, isPublic: true, playerCount: 3 })))
      );
    });
    const upstream = new Server(http, { path: "/api/ws" });
    setupSocket(upstream, rooms);
    await new Promise<void>((resolve) => http.listen(0, "127.0.0.1", resolve));
    const address = http.address();
    if (!address || typeof address === "string") throw new Error("本地监听失败");
    const url = `http://127.0.0.1:${address.port}`;
    const service = new CEEOriginalService({
      data,
      serverUrl: url,
      aesSecret: LOCAL_AES_SECRET,
    });
    const tokens = new Map<string, string>();
    // 入房走统一房号目录给出的目标；联调直接按「别名即上游房号」构造，同 CEEOriginalService 单测。
    const target = (roomId = "1234") => ({
      source: "original" as const,
      roomId,
      upstreamRoomId: roomId,
    });
    const execute = async (id: string, message: CEERoomClientMessage): Promise<unknown> => {
      const result =
        message.type === "cee.room.create"
          ? await service.create(id, target(message.payload.roomId), message.payload)
          : message.type === "cee.room.join"
            ? await service.join(id, target(message.roomId), message.payload)
            : await service.execute(id, { ...message, sessionToken: tokens.get(id) });
      if (
        result &&
        typeof result === "object" &&
        "sessionToken" in result &&
        typeof result.sessionToken === "string"
      )
        tokens.set(id, result.sessionToken);
      return result;
    };
    const original = connect(url, {
      path: "/api/ws",
      transports: ["websocket"],
      reconnection: false,
    });
    // socket.io 客户端不是 EventTarget，node:events 的 once 类型对不上，这里自己包一层。
    const next = (event: string) =>
      new Promise<unknown[]>((resolve) =>
        original.once(event, (...args: unknown[]) => resolve(args))
      );
    const packets: unknown[] = [];
    service.registerConnection({
      id: "host",
      lobbySubscribed: false,
      send: (value) => packets.push(value),
      close() {},
    });
    service.registerConnection({
      id: "guest",
      lobbySubscribed: false,
      send: (value) => packets.push(value),
      close() {},
    });
    try {
      const entered = (await execute("host", {
        id: "create",
        type: "cee.room.create",
        payload: {
          source: "original",
          roomId: "1234",
          name: "混合联调",
          userName: "增强房主",
          visibility: "public",
          allowSpectators: true,
        },
      })) as CEERoomEnterResult;
      expect(entered.snapshot.name).toBe("混合联调");
      if (!original.connected) await next("connect");
      original.emit("joinRoom", { roomId: "1234", username: "原版玩家" });
      await next("updatePlayers");
      original.emit("toggleReady", { roomId: "1234" });
      await execute("guest", {
        id: "join",
        type: "cee.room.join",
        roomId: "1234",
        payload: { userName: "增强玩家" },
      });
      await execute("guest", { id: "ready", type: "cee.player.ready", payload: { ready: true } });
      await execute("host", {
        id: "spectate",
        type: "cee.player.spectate",
        payload: { spectator: true },
      });
      await execute("host", {
        id: "settings",
        type: "cee.room.settings",
        payload: {
          settings: {
            ...createDefaultCEESettings(),
            syncMode: true,
            nonstopMode: true,
            tagBan: true,
            timeLimit: 0,
          },
        },
      });
      const state = () =>
        execute("guest", {
          id: crypto.randomUUID(),
          type: "cee.room.requestSync",
          payload: {},
        }) as Promise<CEERoomEnterResult>;
      await execute("host", { id: "start", type: "cee.game.start", payload: {} });
      await execute("guest", {
        id: "guess1",
        type: "cee.game.guess",
        payload: { characterId: 901 },
      });
      const firstRound = await original.timeout(3000).emitWithAck("playerGuess", {
        roomId: "1234",
        sharedMetaTags: ["最后标签"],
        guessResult: { guessData: { id: 902, name: "原版错误", appearances: [], rawTags: [] } },
      });
      expect(firstRound.tagBanApplied).toBe(true);
      expect((await state()).snapshot.syncRound).toBe(2);
      await execute("guest", { id: "win1", type: "cee.game.guess", payload: { characterId: 900 } });
      const ending = next("gameEnded");
      const win = await original.timeout(3000).emitWithAck("playerGuess", {
        roomId: "1234",
        sharedMetaTags: [],
        guessResult: { guessData: { id: 900, name: "原版猜中", appearances: [], rawTags: [] } },
      });
      expect(win.settlement.rank).toBe(1);
      await ending;
      await Bun.sleep(30);
      const result = await state();
      expect(result.snapshot.phase).toBe("settled");
      expect(
        result.snapshot.roundSummary?.scores
          .filter((score) => score.base)
          .map((score) => score.rank)
      ).toEqual([1, 1]);
      expect(
        result.snapshot.roundSummary?.scores
          .filter((score) => score.base)
          .map((score) => score.score)
      ).toEqual([4, 4]);
      await execute("guest", {
        id: "chat",
        type: "cee.chat.send",
        payload: { text: "增强版频道" },
      });
      expect((await state()).snapshot.chat.at(-1)?.text).toBe("增强版频道");
      await execute("host", { id: "next", type: "cee.game.next", payload: {} });
      await Bun.sleep(30);
      expect((await state()).snapshot.roundNumber).toBe(2);
      expect((await state()).privateState.guesses).toEqual([]);
    } finally {
      service.close();
      original.disconnect();
      http.closeAllConnections();
      await new Promise<void>((resolve) => upstream.close(resolve));
    }
  },
  15000
);
