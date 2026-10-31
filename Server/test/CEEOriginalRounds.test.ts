import { afterEach, describe, expect, test } from "bun:test";
import { CEEOriginalService } from "../src/application/CEEOriginalService";
import { encodeOriginalCharacter } from "../src/infrastructure/CEEOriginalProtocol";
import type { CEEDataProvider, CEERawCharacter } from "../src/infrastructure/CEEData";
import {
  createDefaultCEESettings,
  type CEECharacterView,
  type CEERoomClientMessage,
  type CEECommand,
  type CEEPayload,
  type CEEPrivateState,
  type CEERoomEnterResult,
} from "../src/shared/CEE";
import type { CEERankedCommand } from "../src/shared/CEERanked";
import { FixtureRoom, originalCharacter as character, originalData } from "./CEEOriginalFixtures";
import { deferred } from "./CEENativeFixtures";

const services: CEEOriginalService[] = [];
afterEach(() => services.splice(0).forEach((service) => service.close()));
async function setup(
  data: Partial<CEEDataProvider> = {},
  options: Partial<ConstructorParameters<typeof CEEOriginalService>[0]> = {}
) {
  const upstream = new FixtureRoom();
  const service = new CEEOriginalService({
    data: { ...originalData, ...data },
    serverUrl: "https://rounds.invalid",
    aesSecret: "round-key",
    socketFactory: upstream.factory,
    fetcher: async () => Response.json([{ id: "1234" }]),
    ...options,
  });
  services.push(service);
  const tokens = new Map<string, string>();
  const states = new Map<string, CEEPrivateState>();
  const listeners = new Set<() => void>();
  const connect = (id: string) =>
    service.registerConnection({
      id,
      lobbySubscribed: false,
      close() {},
      send(value) {
        const event = value as { event?: string; payload?: CEEPrivateState };
        if (event.event === "cee.game.privateState") states.set(id, event.payload!);
        for (const listener of listeners) listener();
      },
    });
  const send = async <T extends Exclude<CEECommand, CEERankedCommand>>(
    id: string,
    type: T,
    payload: CEEPayload<T>
  ) => {
    const result = await service.execute(id, {
      id: crypto.randomUUID(),
      type,
      roomId: "1234",
      sessionToken: tokens.get(id),
      payload,
    } as CEERoomClientMessage);
    if (result && typeof result === "object" && "sessionToken" in result)
      tokens.set(id, String(result.sessionToken));
    return result;
  };
  const target = { source: "original" as const, roomId: "1234", upstreamRoomId: "1234" };
  connect("one");
  tokens.set(
    "one",
    (
      await service.create("one", target, {
        source: "original",
        roomId: "1234",
        name: "代数验证",
        userName: "one",
        visibility: "public",
        allowSpectators: true,
      })
    ).sessionToken
  );
  const join = async (id: string) => {
    connect(id);
    tokens.set(id, (await service.join(id, target, { userName: id })).sessionToken);
  };
  const sync = (id = "one") => send(id, "cee.room.requestSync", {}) as Promise<CEERoomEnterResult>;
  const start = (value: unknown) => ({
    character: value,
    settings: createDefaultCEESettings(),
    players: upstream.players,
  });
  const end = () => ({ guesses: [], scoreDetails: [] });
  const guesses = (index = 0) =>
    upstream.sockets[index].sent
      .filter((item) => item.event === "playerGuess")
      .map(
        (item) =>
          (item.payload as { guessResult: { guessData: { popularity: number } } }).guessResult
            .guessData.popularity
      );
  const waitState = (predicate: (state: CEEPrivateState) => boolean, id = "one") =>
    new Promise<void>((resolve) => {
      const check = () => {
        const state = states.get(id);
        if (state && predicate(state)) {
          listeners.delete(check);
          resolve();
        }
      };
      listeners.add(check);
      check();
    });
  return { service, upstream, send, join, sync, start, end, guesses, waitState };
}

describe("原版房间对局代数", () => {
  for (const encrypted of [false, true])
    test(`相同答案载荷连续两局重建资料，每连接开局和后来者只绑定一次（加密${encrypted}）`, async () => {
      let loads = 0;
      const h = await setup({
        async getCharacter(id) {
          return { ...character(id), popularity: ++loads };
        },
      });
      await h.join("two");
      const payload = encrypted
        ? encodeOriginalCharacter(character(), "round-key")
        : { id: 900, name: "同一答案", appearances: [] };
      h.upstream.broadcast("gameStart", h.start(payload));
      await h.send("one", "cee.game.guess", { characterId: 901 });
      h.upstream.broadcast("gameEnded", h.end());
      h.upstream.broadcast("gameStart", h.start(payload));
      await h.send("one", "cee.game.guess", { characterId: 901 });
      await h.send("two", "cee.game.guess", { characterId: 901 });
      expect(h.guesses()).toEqual([1, 2]);
      expect(h.guesses(1)).toEqual([2]);
      expect((await h.sync()).snapshot.roundNumber).toBe(2);
      expect((await h.sync("two")).snapshot.roundNumber).toBe(2);
      await h.join("late");
      h.upstream.sockets[2].receive("gameStart", h.start(payload));
      await h.send("late", "cee.game.guess", { characterId: 901 });
      expect(h.guesses(2)).toEqual([2]);
      expect(loads).toBe(2);
      expect((await h.sync("late")).snapshot.roundNumber).toBe(2);
    });

  test("旧连接迟到请求不能回退新局缓存，旧代结算不结束新代，随后能追上当前代", async () => {
    let loads = 0;
    const h = await setup({
      async getCharacter(id) {
        return { ...character(id), popularity: ++loads };
      },
    });
    await h.join("two");
    const a = encodeOriginalCharacter(character(), "round-key"),
      b = encodeOriginalCharacter(character(), "round-key");
    h.upstream.broadcast("gameStart", h.start(a));
    await h.send("one", "cee.game.guess", { characterId: 901 });
    h.upstream.sockets[0].receive("gameEnded", h.end());
    h.upstream.sockets[0].receive("gameStart", h.start(b));
    await h.send("one", "cee.game.guess", { characterId: 901 });
    await expect(h.send("two", "cee.game.guess", { characterId: 902 })).rejects.toMatchObject({
      code: "CEE_ROUND_CHANGED",
    });
    await h.send("one", "cee.game.guess", { characterId: 901 });
    expect(h.guesses()).toEqual([1, 2, 2]);
    expect(loads).toBe(2);
    h.upstream.sockets[1].receive("gameEnded", h.end());
    h.upstream.sockets[1].receive("gameStart", h.start(b));
    expect((await h.sync("two")).snapshot.roundNumber).toBe(2);
    await h.send("two", "cee.game.guess", { characterId: 901 });
    expect(h.guesses(1)).toEqual([2]);
    expect(loads).toBe(2);
  });

  test("后来者迟到的已知旧载荷不会把当前局退回去，接着收到当前载荷可正常加入", async () => {
    let loads = 0;
    const h = await setup({
      async getCharacter(id) {
        return { ...character(id), popularity: ++loads };
      },
    });
    const a = encodeOriginalCharacter(character(), "round-key"),
      b = encodeOriginalCharacter(character(), "round-key");
    h.upstream.broadcast("gameStart", h.start(a));
    await h.send("one", "cee.game.guess", { characterId: 901 });
    h.upstream.broadcast("gameEnded", h.end());
    h.upstream.broadcast("gameStart", h.start(b));
    await h.send("one", "cee.game.guess", { characterId: 901 });
    await h.join("late");
    h.upstream.sockets[1].receive("gameStart", h.start(a));
    h.upstream.sockets[1].receive("gameEnded", h.end());
    await h.send("one", "cee.game.guess", { characterId: 901 });
    expect(h.guesses()).toEqual([1, 2, 2]);
    h.upstream.sockets[1].receive("gameStart", h.start(b));
    await h.send("late", "cee.game.guess", { characterId: 901 });
    expect((await h.sync("late")).snapshot.roundNumber).toBe(2);
    expect(h.guesses(1)).toEqual([2]);
    expect(loads).toBe(2);
  });

  test("后来者进房即沿用共享房间已知局数，不必等到下一局开局", async () => {
    const h = await setup();
    h.upstream.broadcast("gameStart", h.start({ id: 900, name: "第一局", appearances: [] }));
    h.upstream.broadcast("gameEnded", h.end());
    await h.join("late");
    expect((await h.sync("late")).snapshot.roundNumber).toBe(1);
    expect((await h.sync()).snapshot.roundNumber).toBe(1);
  });

  test("相同载荷新局开始后旧查询返回不能提交或占用新局资料缓存", async () => {
    const pending = deferred<CEECharacterView>(),
      started = deferred<void>();
    let loads = 0;
    const h = await setup({
      async getCharacter(id) {
        if (++loads === 1) {
          started.resolve();
          return pending.promise;
        }
        return { ...character(id), popularity: 222 };
      },
    });
    const payload = encodeOriginalCharacter(character(), "round-key");
    h.upstream.broadcast("gameStart", h.start(payload));
    const old = h.send("one", "cee.game.guess", { characterId: 901 }).then(
      () => "accepted",
      (error) => error.code as string
    );
    await started.promise;
    h.upstream.broadcast("gameEnded", h.end());
    h.upstream.broadcast("gameStart", h.start(payload));
    pending.resolve({ ...character(901), popularity: 111 });
    expect(await old).toBe("CEE_ROUND_CHANGED");
    await h.send("one", "cee.game.guess", { characterId: 901 });
    expect(h.guesses()).toEqual([222]);
    expect(loads).toBe(2);
  });

  test("相同载荷新局答案补全先完成时，旧补全稍后返回不能覆盖新标签", async () => {
    const pending = deferred<CEERawCharacter>(),
      started = deferred<void>();
    let loads = 0;
    const raw = async (tag: string) => ({
      ...(await originalData.getRawCharacter(900)),
      extraTagsBySubject: {
        225878: [{ section: "阵营", tags: [tag] }],
      },
    });
    const h = await setup({
      async getRawCharacter() {
        if (++loads === 1) {
          started.resolve();
          return pending.promise;
        }
        return raw("新局标签");
      },
    });
    h.upstream.players[0].team = "0";
    const payload = { id: 900, name: "答案", appearances: ["作品"], appearanceIds: [225878] };
    h.upstream.broadcast("gameStart", h.start(payload));
    await started.promise;
    h.upstream.broadcast("gameEnded", h.end());
    h.upstream.broadcast("gameStart", h.start(payload));
    await h.waitState((state) => state.answer?.extraTags[0]?.tags[0] === "新局标签");
    pending.resolve(await raw("旧局标签"));
    await pending.promise;
    expect((await h.sync()).privateState.answer?.extraTags).toEqual([
      { section: "阵营", tags: ["新局标签"] },
    ]);
    expect(loads).toBe(2);
  });

  test("图片加工跨过相同载荷新局后返回明确过期错误", async () => {
    const image = deferred<string>(),
      started = deferred<void>();
    const h = await setup(
      {},
      {
        imageHints: {
          async render() {
            started.resolve();
            return image.promise;
          },
        },
      }
    );
    const payload = encodeOriginalCharacter(character(), "round-key");
    const start = () => ({
      ...h.start(payload),
      settings: { ...createDefaultCEESettings(), useImageHint: 10 },
    });
    h.upstream.broadcast("gameStart", start());
    const old = h.send("one", "cee.game.imageHint", {}).then(
      () => "accepted",
      (error) => error.code as string
    );
    await started.promise;
    h.upstream.broadcast("gameEnded", h.end());
    h.upstream.broadcast("gameStart", start());
    image.resolve("data:image/webp;base64,old");
    expect(await old).toBe("CEE_ROUND_CHANGED");
    expect((await h.sync()).snapshot.roundNumber).toBe(2);
  });

  test("上一局猜测确认迟到时拒绝过期响应，不把旧标签回退事件发送进新局", async () => {
    const submitted = deferred<void>();
    let finish!: (payload: unknown) => void;
    const h = await setup();
    const socket = h.upstream.sockets[0];
    const emit = socket.emit.bind(socket);
    socket.emit = (event, payload, ack) => {
      if (event === "playerGuess") {
        socket.sent.push({ event, payload });
        finish = ack!;
        submitted.resolve();
      } else emit(event, payload, ack);
    };
    const payload = encodeOriginalCharacter(character(), "round-key");
    const start = () => ({
      ...h.start(payload),
      settings: { ...createDefaultCEESettings(), tagBan: true },
    });
    h.upstream.broadcast("gameStart", start());
    const old = h.send("one", "cee.game.guess", { characterId: 901 }).then(
      () => "accepted",
      (error) => error.code as string
    );
    await submitted.promise;
    h.upstream.broadcast("gameEnded", h.end());
    h.upstream.broadcast("gameStart", start());
    finish({ ok: true });
    expect(await old).toBe("CEE_ROUND_CHANGED");
    expect(socket.sent.some((item) => item.event === "tagBanSharedMetaTags")).toBe(false);
    expect((await h.sync()).snapshot.roundNumber).toBe(2);
  });
});
