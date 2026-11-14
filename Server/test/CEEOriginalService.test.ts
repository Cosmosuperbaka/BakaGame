import { afterEach, describe, expect, test } from "bun:test";
import { CEEOriginalService } from "../src/application/CEEOriginalService";
import { originalRoomDisplayName } from "../src/application/CEEOriginalView";
import type { ConnectionRecord } from "../src/shared/Index";
import { AppError } from "../src/domain/Errors";
import { encodeOriginalCharacter } from "../src/infrastructure/CEEOriginalProtocol";
import {
  createDefaultCEESettings,
  type CEEPrivateState,
  type CEERoomClientMessage,
  type CEERoomEnterResult,
} from "../src/shared/CEE";

import {
  originalCharacter as character,
  originalData as data,
  FixtureRoom,
} from "./CEEOriginalFixtures";
import { deferred } from "./CEENativeFixtures";
import type { CEECharacterView } from "../src/shared/CEE";

const services: CEEOriginalService[] = [];
afterEach(() => services.splice(0).forEach((service) => service.close()));

function setup(options: Partial<ConstructorParameters<typeof CEEOriginalService>[0]> = {}) {
  const upstream = new FixtureRoom();
  const service = new CEEOriginalService({
    data,
    serverUrl: "https://original.example",
    aesSecret: "fixture-key",
    socketFactory: upstream.factory,
    fetcher: async () => Response.json([{ id: "1234", isPublic: true, playerCount: 2 }]),
    imageHints: {
      async render(_url, level) {
        return `data:image/webp;base64,blur-${level}`;
      },
    },
    ...options,
  });
  services.push(service);
  const packets: unknown[] = [];
  const connection = (id: string): ConnectionRecord => ({
    id,
    lobbySubscribed: false,
    send: (packet) => packets.push(packet),
    close() {},
  });
  const first = connection("first");
  service.registerConnection(first);
  return { service, upstream, packets, first, connection };
}
const tokens = new WeakMap<CEEOriginalService, Map<string, string>>();
/** 直接驱动原版适配器：入房指令按「别名即上游房号」构造目标，统一房号目录另有 CEEService 级用例。 */
const target = (roomId = "1234") => ({
  source: "original" as const,
  roomId,
  upstreamRoomId: roomId,
});
const request = async (
  service: CEEOriginalService,
  id: string,
  message: CEERoomClientMessage
): Promise<unknown> => {
  if (!tokens.has(service)) tokens.set(service, new Map());
  const result =
    message.type === "cee.room.create"
      ? await service.create(id, target(message.payload.roomId), message.payload)
      : message.type === "cee.room.join"
        ? await service.join(id, target(message.roomId), message.payload)
        : message.type === "cee.room.reconnect"
          ? service.reconnect(id, target(message.payload.roomId), message.payload.sessionToken)
          : await service.execute(id, {
              ...message,
              sessionToken: message.sessionToken ?? tokens.get(service)!.get(id),
            });
  if (
    result &&
    typeof result === "object" &&
    "sessionToken" in result &&
    typeof result.sessionToken === "string"
  )
    tokens.get(service)!.set(id, result.sessionToken);
  return result;
};
const create = (service: CEEOriginalService, id = "first", name = "甲") =>
  request(service, id, {
    id: "create",
    type: "cee.room.create",
    payload: {
      source: "original",
      roomId: "1234",
      name: "测试房间",
      userName: name,
      visibility: "public",
      allowSpectators: true,
    },
  }) as Promise<CEERoomEnterResult>;
const sync = (service: CEEOriginalService, id = "first") =>
  request(service, id, {
    id: "sync",
    type: "cee.room.requestSync",
    payload: {},
  }) as Promise<CEERoomEnterResult>;

describe("原版房显示名", () => {
  test("有房名用房名，没有就用房主名拼，都没有给通用称谓", () => {
    expect(originalRoomDisplayName("周末局", "阿虚")).toBe("周末局");
    expect(originalRoomDisplayName("", "阿虚")).toBe("阿虚的房间");
    expect(originalRoomDisplayName("", "")).toBe("原版房间");
  });
});

describe("原版房间适配", () => {
  test("加入检查尚未完成时拒绝重复加入，客户端断线后不创建上游会话", async () => {
    let release!: (response: Response) => void;
    const pending = new Promise<Response>((resolve) => {
      release = resolve;
    });
    const { service, upstream } = setup({ fetcher: () => pending });
    const join = {
      id: "join",
      type: "cee.room.join",
      roomId: "1234",
      payload: { userName: "甲" },
    } as const;
    const first = request(service, "first", join);
    expect(service.hasSession("first")).toBe(true);
    await expect(request(service, "first", { ...join, id: "duplicate" })).rejects.toMatchObject({
      code: "CEE_JOIN_PENDING",
    });
    service.unregisterConnection("first");
    release(Response.json([{ id: "1234" }]));
    await expect(first).rejects.toMatchObject({ code: "CONNECTION_NOT_FOUND" });
    expect(upstream.sockets).toHaveLength(0);
  });

  test("配置缺失明确不可用，陌生房号不发送会意外建房的加入事件", async () => {
    const missing = setup({ serverUrl: undefined, aesSecret: undefined });
    await expect(create(missing.service)).rejects.toMatchObject({
      code: "CEE_ORIGINAL_UNAVAILABLE",
    });
    expect(missing.upstream.sockets).toHaveLength(0);
    const { service, upstream } = setup({ fetcher: async () => Response.json([]) });
    await expect(
      request(service, "first", {
        id: "join",
        type: "cee.room.join",
        roomId: "5678",
        payload: { userName: "甲" },
      })
    ).rejects.toMatchObject({ code: "ROOM_NOT_FOUND" });
    expect(upstream.sockets).toHaveLength(0);
  });

  test("房间列表请求失败：对外统一不可用，日志里保留 HTTP 状态与超时等具体原因", async () => {
    const warns: Array<{ message: string; detail: unknown }> = [];
    const logger = { warn: (message: string, detail?: unknown) => warns.push({ message, detail }) };
    const http = setup({ logger, fetcher: async () => new Response("x", { status: 503 }) });
    await expect(http.service.listUpstreamRooms()).rejects.toMatchObject({
      code: "CEE_ORIGINAL_UNAVAILABLE",
    });
    const shape = setup({ logger, fetcher: async () => Response.json({ not: "list" }) });
    await expect(shape.service.listUpstreamRooms()).rejects.toMatchObject({
      code: "CEE_ORIGINAL_UNAVAILABLE",
    });
    const timeout = setup({
      logger,
      fetcher: async () => {
        throw new DOMException("timeout", "TimeoutError");
      },
    });
    await expect(timeout.service.listUpstreamRooms()).rejects.toMatchObject({
      code: "CEE_ORIGINAL_UNAVAILABLE",
    });
    expect(warns.map((item) => item.detail)).toEqual([
      { reason: "HTTP 503" },
      { reason: "shape" },
      { reason: "TimeoutError" },
    ]);
  });

  test("上游事件载荷无法转换：撤销会话，日志带事件名与失败类别而不含载荷", async () => {
    const warns: Array<{ message: string; detail: unknown }> = [];
    const { service, upstream } = setup({
      logger: { warn: (message, detail) => warns.push({ message, detail }) },
    });
    await request(service, "first", {
      id: "join",
      type: "cee.room.join",
      roomId: "1234",
      payload: { userName: "甲" },
    });
    upstream.broadcast("updatePlayers", "secret-payload-text");
    expect(warns).toEqual([
      {
        message: "原版房间状态转换失败",
        detail: { event: "updatePlayers", reason: "CEE_ORIGINAL_PROTOCOL" },
      },
    ]);
    expect(service.hasSession("first")).toBe(false);
  });

  test("原版非公开房在上游列表中标记为非公开，仍可按房号加入", async () => {
    const { service, upstream } = setup({
      fetcher: async () => Response.json([{ id: "1234", isPublic: false, playerCount: 1 }]),
    });
    const [listed] = await service.listUpstreamRooms();
    // 上游一个名称字段都没给：显示名用通用称谓，不能只剩「的房间」这个后缀。
    expect(listed).toEqual({
      id: "1234",
      isPublic: false,
      name: "原版房间",
      phase: "waiting",
      playerCount: 1,
    });
    const entered = (await request(service, "first", {
      id: "private-join",
      type: "cee.room.join",
      roomId: "1234",
      payload: { userName: "甲" },
    })) as CEERoomEnterResult;
    expect(entered.roomId).toBe("1234");
    expect(upstream.sockets[0].sent[0]).toMatchObject({ event: "joinRoom" });
  });

  test("创建和更新长房名按原版三十字限制确认，不误报已成功的操作超时", async () => {
    const { service } = setup();
    const name = "很长的角色猜测房间名称".repeat(3).slice(0, 32);
    const entered = (await request(service, "first", {
      id: "long-create",
      type: "cee.room.create",
      payload: {
        source: "original",
        roomId: "1234",
        name,
        userName: "甲",
        visibility: "public",
        allowSpectators: true,
      },
    })) as CEERoomEnterResult;
    expect(entered.snapshot.name).toBe(name.slice(0, 30));
    const updated = "另一间用于多人猜测的角色房间名称";
    await request(service, "first", {
      id: "long-update",
      type: "cee.room.update",
      payload: {
        name: updated,
        visibility: "public",
        allowSpectators: true,
      },
    });
    expect((await sync(service)).snapshot.name).toBe(updated);
  });

  test("关闭作品搜索时猜题者不能绕过查询限制，零阈值提示对观战者也不显示", async () => {
    const { service, upstream } = setup();
    await create(service);
    upstream.broadcast("gameStart", {
      character: encodeOriginalCharacter(character(), "fixture-key"),
      settings: { ...createDefaultCEESettings(), subjectSearch: false, useHints: [0, 3] },
      players: upstream.players,
      hints: ["禁用提示", "允许提示"],
    });
    for (const command of [
      { type: "cee.subject.search", payload: { keyword: "作品" } },
      { type: "cee.subject.characters", payload: { subjectId: 10 } },
    ] as const)
      await expect(
        request(service, "first", { id: crypto.randomUUID(), ...command })
      ).rejects.toMatchObject({ code: "SUBJECT_SEARCH_DISABLED" });
    upstream.players[0].team = "0";
    upstream.broadcast("updatePlayers", { players: upstream.players });
    expect((await sync(service)).privateState.hints).toEqual(["允许提示"]);
    expect(
      await request(service, "first", {
        id: "observer-search",
        type: "cee.subject.search",
        payload: { keyword: "作品" },
      })
    ).toEqual({ results: [] });
    upstream.broadcast("gameEnded", { guesses: [], scoreDetails: [] });
    expect((await sync(service)).privateState.hints).toEqual(["允许提示"]);
  });

  describe("原版房目录导入的房主与阶段守卫", () => {
    const importCommand = {
      id: "import",
      type: "cee.directory.import",
      payload: { indexId: 7 },
    } as const;
    const setupWithImportCounter = () => {
      let imports = 0;
      const context = setup({
        data: {
          ...data,
          async importDirectory(indexId) {
            imports += 1;
            return data.importDirectory(indexId);
          },
        },
      });
      return { ...context, imports: () => imports };
    };
    const joinSecond = async (context: ReturnType<typeof setupWithImportCounter>) => {
      context.service.registerConnection(context.connection("second"));
      await request(context.service, "second", {
        id: "join",
        type: "cee.room.join",
        roomId: "1234",
        payload: { userName: "乙" },
      });
    };
    const startUpstreamRound = (upstream: FixtureRoom) =>
      upstream.broadcast("gameStart", {
        character: encodeOriginalCharacter(character(), "fixture-key"),
        settings: createDefaultCEESettings(),
        players: upstream.players,
      });

    test("房主在等待阶段可以导入", async () => {
      const context = setupWithImportCounter();
      await create(context.service);
      expect(await request(context.service, "first", importCommand)).toMatchObject({ id: 7 });
      expect(context.imports()).toBe(1);
    });

    test("非房主被拒，且不触发导入", async () => {
      const context = setupWithImportCounter();
      await create(context.service);
      await joinSecond(context);
      await expect(request(context.service, "second", importCommand)).rejects.toMatchObject({
        code: "FORBIDDEN",
      });
      expect(context.imports()).toBe(0);
    });

    test("房主在对局中被拒，且不触发导入", async () => {
      const context = setupWithImportCounter();
      await create(context.service);
      startUpstreamRound(context.upstream);
      await expect(request(context.service, "first", importCommand)).rejects.toMatchObject({
        code: "INVALID_PHASE",
      });
      expect(context.imports()).toBe(0);
    });

    test("同时违反两条时先报房主错误，与增强房同序", async () => {
      const context = setupWithImportCounter();
      await create(context.service);
      await joinSecond(context);
      startUpstreamRound(context.upstream);
      await expect(request(context.service, "second", importCommand)).rejects.toMatchObject({
        code: "FORBIDDEN",
      });
      expect(context.imports()).toBe(0);
    });
  });

  test("每位玩家独立上游会话，仅确认加入的增强玩家共享聊天，离开即撤权", async () => {
    const { service, upstream, first, connection } = setup();
    const created = await create(service);
    expect(created.source).toBe("original");
    expect(first.roomId).toBe("original:1234");
    expect(upstream.sockets[0].sent[0].payload).toEqual({ roomId: "1234", username: "甲" });
    const second = connection("second");
    service.registerConnection(second);
    await request(service, "second", {
      id: "join",
      type: "cee.room.join",
      roomId: "1234",
      payload: { userName: "乙" },
    });
    expect(upstream.sockets).toHaveLength(2);
    await expect(
      request(service, "first", {
        id: "invalid",
        type: "cee.chat.send",
        sessionToken: "wrong-token",
        payload: { text: "冒名消息" },
      })
    ).rejects.toMatchObject({ code: "SESSION_INVALID" });
    await request(service, "first", {
      id: "chat",
      type: "cee.chat.send",
      payload: { text: "你好" },
    });
    expect((await sync(service, "second")).snapshot.chat[0].text).toBe("你好");
    // 正向对照：两个上游连接都确实发过入房事件，下面的否定断言不是在空集上恒真。
    expect(upstream.sockets.map((socket) => socket.sent[0]?.event)).toEqual([
      "createRoom",
      "joinRoom",
    ]);
    expect(
      upstream.sockets.every((socket) =>
        socket.sent.every((item) => item.event !== "updatePlayerMessage")
      )
    ).toBe(true);
    await request(service, "first", { id: "leave", type: "cee.room.leave", payload: {} });
    await expect(
      request(service, "first", {
        id: "chat",
        type: "cee.chat.send",
        payload: { text: "不能发送" },
      })
    ).rejects.toMatchObject({ code: "NOT_IN_ROOM" });
    expect(first.roomId).toBeUndefined();
  });

  /**
   * 原版会自行裁剪用户名。若确认谓词做全等比对，带空格的用户名会让加入一直等到 8s 超时，
   * 表现为「加入原版房间失败」而没有任何上游错误。
   */
  test("加入时按裁剪后的用户名确认，玩家编号为数字也能命中", async () => {
    const { service, upstream, first } = setup();
    const entered = (await request(service, "first", {
      id: "join",
      type: "cee.room.join",
      roomId: "1234",
      payload: { userName: "  甲  " },
    })) as CEERoomEnterResult;
    expect(entered.source).toBe("original");
    expect(upstream.sockets[0].sent[0].payload).toEqual({ roomId: "1234", username: "甲" });
    expect(first.roomId).toBe("original:1234");
  });

  test("裁剪敌方历史、答案及被禁标签，解锁后仅返回加工后的图片", async () => {
    const { service, upstream, packets } = setup();
    await create(service);
    const me = upstream.players[0];
    const other = {
      id: "enemy",
      username: "原版玩家",
      ready: true,
      isHost: false,
      team: null,
      guesses: "",
      score: 0,
    };
    upstream.players.push(other);
    const settings = {
      ...createDefaultCEESettings(),
      tagBan: true,
      useHints: [3],
      useImageHint: 3,
    };
    upstream.broadcast("gameStart", {
      character: encodeOriginalCharacter(character(), "fixture-key"),
      settings,
      players: upstream.players,
      isPublic: true,
      hints: ["不会泄露的提示"],
    });
    const rawGuess = {
      id: 901,
      name: "猜测",
      appearances: ["作品"],
      appearanceIds: [10],
      rawTags: [["校园", 1]],
      metaTags: ["校园"],
    };
    upstream.broadcast("guessHistoryUpdate", {
      guesses: [
        {
          username: "甲",
          guesses: [
            { playerId: me.id, guessData: rawGuess, isCorrect: false, isPartialCorrect: true },
          ],
        },
        {
          username: "原版玩家",
          guesses: [{ playerId: "enemy", guessData: { ...rawGuess, id: 902 }, isCorrect: false }],
        },
      ],
    });
    upstream.broadcast("tagBanStateUpdate", {
      tagBanState: [{ tag: "校园", revealer: ["enemy"] }],
    });
    let state = await sync(service);
    expect(state.privateState.answer).toBeNull();
    expect(state.privateState.hints).toEqual([]);
    expect(state.privateState.guesses).toHaveLength(1);
    expect(state.privateState.guesses[0].feedback.tags[0]).toEqual({
      text: "???",
      matched: false,
      hidden: true,
      kind: "subject",
    });
    expect(state.snapshot.roundSummary).toBeNull();
    await expect(
      request(service, "first", { id: "hint", type: "cee.game.imageHint", payload: {} })
    ).rejects.toMatchObject({ code: "CEE_HINT_LOCKED" });
    me.guesses = "❌".repeat(7);
    upstream.broadcast("updatePlayers", { players: upstream.players });
    upstream.broadcast("resetTimer", { deadlineAt: 123456 });
    state = await sync(service);
    expect(state.privateState.hints).toEqual(["不会泄露的提示"]);
    expect(state.privateState.deadlineAt).toBe(123456);
    upstream.broadcast("resetTimer", undefined);
    expect(service.hasSession("first")).toBe(true);
    expect(
      await request(service, "first", { id: "hint", type: "cee.game.imageHint", payload: {} })
    ).toEqual({ dataUrl: "data:image/webp;base64,blur-3" });
    expect(JSON.stringify(packets)).not.toContain("https://images.example/900.jpg");
  });

  test("拒绝猜测不登记标签，接受猜测只传服务端算出的反馈", async () => {
    const { service, upstream } = setup();
    await create(service);
    upstream.broadcast("gameStart", {
      character: encodeOriginalCharacter(character(), "fixture-key"),
      settings: { ...createDefaultCEESettings(), tagBan: true },
      players: upstream.players,
      isPublic: true,
    });
    const socket = upstream.sockets[0];
    socket.failGuess = true;
    await expect(
      request(service, "first", {
        id: "guess",
        type: "cee.game.guess",
        payload: { characterId: 901 },
      })
    ).rejects.toMatchObject({ code: "CEE_ORIGINAL_REJECTED" });
    expect(socket.sent.some((item) => item.event === "tagBanSharedMetaTags")).toBe(false);
    socket.failGuess = false;
    await request(service, "first", {
      id: "guess",
      type: "cee.game.guess",
      payload: { characterId: 901 },
    });
    expect(socket.sent.at(-1)).toMatchObject({
      event: "tagBanSharedMetaTags",
      payload: { tags: ["校园", "眼镜", "声优"] },
    });
    expect(socket.sent.filter((item) => item.event === "playerGuess").at(-1)).toMatchObject({
      payload: { guessResult: { isCorrect: false, isPartialCorrect: true } },
    });
    socket.atomicTags = true;
    const previousTagEvents = socket.sent.filter(
      (item) => item.event === "tagBanSharedMetaTags"
    ).length;
    await request(service, "first", {
      id: "guess-new",
      type: "cee.game.guess",
      payload: { characterId: 902 },
    });
    expect(socket.sent.at(-1)).toMatchObject({
      event: "playerGuess",
      payload: { sharedMetaTags: ["校园", "眼镜", "声优"] },
    });
    expect(socket.sent.filter((item) => item.event === "tagBanSharedMetaTags")).toHaveLength(
      previousTagEvents
    );
  });

  test("前端重连复用上游连接并恢复房间聊天", async () => {
    const { service, upstream, connection } = setup();
    const entered = await create(service);
    await request(service, "first", {
      id: "chat",
      type: "cee.chat.send",
      payload: { text: "旧房聊天" },
    });
    service.unregisterConnection("first");
    const replacement = connection("replacement");
    service.registerConnection(replacement);
    const restored = (await request(service, "replacement", {
      id: "reconnect",
      type: "cee.room.reconnect",
      payload: { roomId: "1234", sessionToken: entered.sessionToken },
    })) as CEERoomEnterResult;
    expect(restored.snapshot.chat).toHaveLength(1);
    expect(restored.snapshot.chat[0].text).toBe("旧房聊天");
    // 重连是接管已有上游会话，不许另开第二条连接。
    expect(upstream.sockets).toHaveLength(1);
    expect(replacement.roomId).toBe("original:1234");
  });

  test("被上游踢出时立即撤权并清空房间聊天", async () => {
    const { service, upstream, first } = setup();
    await create(service);
    await request(service, "first", {
      id: "chat",
      type: "cee.chat.send",
      payload: { text: "旧房聊天" },
    });
    expect((await sync(service)).snapshot.chat).toHaveLength(1);
    expect(first.roomId).toBe("original:1234");
    upstream.sockets[0].receive("playerKicked", { playerId: upstream.sockets[0].id });
    expect(service.hasSession("first")).toBe(false);
    // 撤权包括摘掉连接上记的房号。
    expect(first.roomId).toBeUndefined();
    expect(upstream.sockets[0].connected).toBe(false);
    expect(service.getHealthSnapshot()).toMatchObject({ sessions: 0, rooms: 0 });
  });

  test("会话超时被清理后，同号房间的旧聊天一并清空", async () => {
    let now = 100;
    const { service, connection } = setup({ now: () => now });
    await create(service);
    await request(service, "first", {
      id: "chat",
      type: "cee.chat.send",
      payload: { text: "旧房聊天" },
    });
    expect((await sync(service)).snapshot.chat).toHaveLength(1);
    service.unregisterConnection("first");
    now += 60_001;
    service.runHousekeeping();
    expect(service.getHealthSnapshot()).toMatchObject({ sessions: 0, rooms: 0 });
    // 超时清理必须连同房间聊天一起丢掉，不能让后来加入的人看到上一轮的旧消息。
    const again = connection("again");
    service.registerConnection(again);
    expect((await create(service, "again", "乙")).snapshot.chat).toEqual([]);
  });

  test("原版结算保留分数和并列名次，下一局清空历史并保留房间聊天", async () => {
    const { service, upstream } = setup();
    await create(service);
    await request(service, "first", { id: "start", type: "cee.game.start", payload: {} });
    upstream.broadcast("nonstopProgress", { winners: [{ username: "甲", rank: 1, score: 15 }] });
    upstream.broadcast("gameEnded", {
      guesses: [],
      scoreDetails: [
        {
          type: "player",
          id: upstream.sockets[0].id,
          username: "甲",
          score: 15,
          breakdown: { rank: 1, base: 3, bigWin: 12 },
        },
      ],
    });
    expect((await sync(service)).snapshot.roundSummary?.scores[0]).toMatchObject({
      score: 15,
      rank: 1,
      firstGuess: 12,
    });
    await request(service, "first", { id: "next", type: "cee.game.next", payload: {} });
    const next = await sync(service);
    expect(next.snapshot.phase).toBe("guessing");
    expect(next.snapshot.roundNumber).toBe(2);
    expect(next.snapshot.roundSummary).toBeNull();
    expect(next.privateState.guesses).toEqual([]);
  });

  test("同房增强玩家共享局内角色冻结，附加标签补全保留原版答案数值且不公开答案标签", async () => {
    let version = "初始";
    let guessesLoaded = 0;
    const rawCalls: number[] = [];
    const { service, upstream, connection, packets } = setup({
      data: {
        ...data,
        async getCharacter(id) {
          return { ...character(id), popularity: ++guessesLoaded === 1 ? 7 : 999 };
        },
        async getRawCharacter(id) {
          rawCalls.push(id);
          return {
            ...(await data.getRawCharacter(id)),
            popularity: 99999,
            extraTagsBySubject: {
              225878: [{ section: "阵营", tags: [version, "答案专有隐藏标签"] }],
            },
          };
        },
      },
    });
    await create(service);
    service.registerConnection(connection("second"));
    await request(service, "second", {
      id: "join",
      type: "cee.room.join",
      roomId: "1234",
      payload: { userName: "乙" },
    });
    const remote = {
      id: 900,
      name: "原版答案",
      popularity: 123,
      highestRating: 9.5,
      earliestAppearance: 1999,
      appearances: ["原版动画"],
      appearanceIds: [10, 225878],
    };
    upstream.broadcast("gameStart", {
      character: remote,
      settings: createDefaultCEESettings(),
      players: upstream.players,
    });
    await request(service, "first", {
      id: "guess-first",
      type: "cee.game.guess",
      payload: { characterId: 901 },
    });
    version = "更新";
    await request(service, "second", {
      id: "guess-second",
      type: "cee.game.guess",
      payload: { characterId: 901 },
    });
    expect(guessesLoaded).toBe(1);
    expect(rawCalls.filter((id) => id === 900)).toHaveLength(1);
    for (const socket of upstream.sockets) {
      expect(socket.sent.find((item) => item.event === "playerGuess")?.payload).toMatchObject({
        guessResult: { guessData: { popularity: 7 } },
      });
    }
    expect(JSON.stringify(packets)).not.toContain("答案专有隐藏标签");
    upstream.players[0].team = "0";
    upstream.broadcast("updatePlayers", { players: upstream.players });
    const answer = (await sync(service)).privateState.answer!;
    expect(answer).toMatchObject({
      name: "原版答案",
      popularity: 123,
      highestRating: 9.5,
      earliestAppearance: 1999,
      extraTags: [{ section: "阵营", tags: ["初始", "答案专有隐藏标签"] }],
    });
    expect(answer.appearances.map((item) => item.name)).toEqual(["原版动画"]);
    upstream.broadcast("gameEnded", { guesses: [], scoreDetails: [] });
    upstream.players[0].team = null;
    upstream.broadcast("gameStart", {
      character: { ...remote, summary: "下一局" },
      settings: createDefaultCEESettings(),
      players: upstream.players,
    });
    await request(service, "first", {
      id: "next-guess",
      type: "cee.game.guess",
      payload: { characterId: 901 },
    });
    expect(guessesLoaded).toBe(2);
    expect(rawCalls.filter((id) => id === 900)).toHaveLength(2);
  });

  test("原版客户端猜测可补SQLite附加标签，仅展示猜测标签与交集并冻结已给出的反馈", async () => {
    let version = "共同标签";
    const { service, upstream, first, packets } = setup({
      data: {
        ...data,
        async getRawCharacter(id) {
          return {
            ...(await data.getRawCharacter(id)),
            extraTagsBySubject: {
              225878: [
                {
                  section: "阵营",
                  tags: id === 900 ? ["共同标签", "答案秘密"] : [version, "错误标签"],
                },
              ],
            },
          };
        },
      },
    });
    await create(service);
    upstream.broadcast("gameStart", {
      character: { id: 900, name: "答案", appearances: ["动画"], appearanceIds: [10, 225878] },
      settings: createDefaultCEESettings(),
      players: upstream.players,
    });
    const completed = new Promise<CEEPrivateState>((resolve) => {
      first.send = (payload) => {
        packets.push(payload);
        const event = payload as { event?: string; payload?: CEEPrivateState };
        if (
          event.event === "cee.game.privateState" &&
          event.payload?.guesses[0]?.feedback.extraTags.length
        )
          resolve(event.payload);
      };
    });
    const history = [
      {
        username: "甲",
        guesses: [
          {
            playerId: upstream.sockets[0].id,
            isCorrect: false,
            isPartialCorrect: true,
            guessData: {
              id: 901,
              name: "猜测",
              popularity: 7,
              appearances: ["动画"],
              appearanceIds: [10, 225878],
            },
          },
        ],
      },
    ];
    upstream.broadcast("guessHistoryUpdate", { guesses: history });
    const state = await completed;
    expect(state.guesses[0].feedback.extraTags).toEqual([
      {
        section: "阵营",
        tags: [
          { text: "共同标签", matched: true },
          { text: "错误标签", matched: false },
        ],
      },
    ]);
    expect(state.answer).toBeNull();
    expect(JSON.stringify(packets)).not.toContain("答案秘密");
    version = "更新后的标签";
    history[0].guesses[0].guessData.popularity = 999;
    upstream.broadcast("guessHistoryUpdate", { guesses: history });
    const replay = await sync(service);
    expect(replay.privateState.guesses[0].feedback.popularity.value).toBe(7);
    expect(replay.privateState.guesses[0].feedback.extraTags).toEqual(
      state.guesses[0].feedback.extraTags
    );
  });

  test("普通上游答案不查询专属标签，专属角色本地缺失也不阻塞正常猜测", async () => {
    let rawCalls = 0;
    const { service, upstream } = setup({
      data: {
        ...data,
        async getRawCharacter() {
          rawCalls++;
          throw new AppError("CEE_CHARACTER_NOT_FOUND", "本地没有该角色");
        },
      },
    });
    await create(service);
    const start = (appearanceIds: number[]) =>
      upstream.broadcast("gameStart", {
        character: { id: 900, name: "原版新增角色", appearances: ["上游作品"], appearanceIds },
        settings: createDefaultCEESettings(),
        players: upstream.players,
      });
    start([10]);
    await request(service, "first", {
      id: "ordinary",
      type: "cee.game.guess",
      payload: { characterId: 901 },
    });
    expect(rawCalls).toBe(0);
    start([10, 225878]);
    await request(service, "first", {
      id: "missing-extra",
      type: "cee.game.guess",
      payload: { characterId: 901 },
    });
    expect(rawCalls).toBe(1);
    expect(upstream.sockets[0].sent.filter((item) => item.event === "playerGuess")).toHaveLength(2);
    upstream.players[0].team = "0";
    upstream.broadcast("updatePlayers", { players: upstream.players });
    expect((await sync(service)).privateState.answer?.extraTags).toEqual([]);
  });

  test("专属标签数据库故障不能伪装成无标签，恢复后可重新读取并继续猜测", async () => {
    let broken = true;
    const { service, upstream } = setup({
      data: {
        ...data,
        async getRawCharacter(id) {
          if (broken) throw new AppError("CEE_DATA_UNAVAILABLE", "数据库暂时不可用");
          return data.getRawCharacter(id);
        },
      },
    });
    await create(service);
    upstream.broadcast("gameStart", {
      character: { id: 900, name: "答案", appearances: ["作品"], appearanceIds: [225878] },
      settings: createDefaultCEESettings(),
      players: upstream.players,
    });
    await expect(
      request(service, "first", {
        id: "broken",
        type: "cee.game.guess",
        payload: { characterId: 901 },
      })
    ).rejects.toMatchObject({ code: "CEE_DATA_UNAVAILABLE" });
    expect(upstream.sockets[0].sent.some((item) => item.event === "playerGuess")).toBe(false);
    broken = false;
    await request(service, "first", {
      id: "retry",
      type: "cee.game.guess",
      payload: { characterId: 901 },
    });
    expect(upstream.sockets[0].sent.filter((item) => item.event === "playerGuess")).toHaveLength(1);
  });

  test("原版同步轮查询跨过超时换轮后拒绝旧猜测，不能消耗下一轮机会", async () => {
    const loading = deferred<CEECharacterView>();
    const { service, upstream } = setup({
      data: {
        ...data,
        async getCharacter() {
          return loading.promise;
        },
      },
    });
    await create(service);
    upstream.broadcast("gameStart", {
      character: encodeOriginalCharacter(character(), "fixture-key"),
      settings: { ...createDefaultCEESettings(), syncMode: true },
      players: upstream.players,
    });
    const pending = request(service, "first", {
      id: "late",
      type: "cee.game.guess",
      payload: { characterId: 901 },
    });
    await Promise.resolve();
    upstream.players[0].guesses = "⏱️";
    upstream.broadcast("updatePlayers", { players: upstream.players });
    upstream.broadcast("syncRoundStart", { round: 2 });
    loading.resolve(character(901));
    await expect(pending).rejects.toMatchObject({ code: "CEE_ROUND_CHANGED" });
    expect(upstream.sockets[0].sent.some((item) => item.event === "playerGuess")).toBe(false);
    expect((await sync(service)).snapshot.syncRound).toBe(2);
  });
});
