import { describe, expect, test } from "bun:test";
import { CEEService } from "../src/application/CEEService";
import { CEERankedService } from "../src/application/CEERankedService";
import { CEE_SEARCH_CONNECTION_MAX } from "../src/application/CEESearchQuota";
import { CEESearchProvenance } from "../src/application/CEEAntiCheatSignals";
import { CEE_RANKED_WINDOW_INITIAL } from "../src/application/CEERankedQueue";
import type { CEERankedPoolProvider } from "../src/application/CEERankedPool";
import type { CEERankedStore } from "../src/application/CEERankedStore";
import { InMemoryCEERankedStore } from "../src/application/CEERankedStore";
import { AppError } from "../src/domain/Errors";
import { EventLogger } from "../src/infrastructure/EventLogger";
import { parseCEEMessage } from "../src/transport/CEEProtocol";
import {
  CEE_RANKED_BOT_FALLBACK_MS,
  CEE_RANKED_BOT_OPTION_MS,
  CEE_RANKED_OFFLINE_FORFEIT_MS,
  CEE_RANKED_PLACEMENT_SERIES,
  type CEERankedCommand,
  type CEERankedPayload,
  type ClientChannelProof,
  type ConnectionRecord,
} from "../src/shared/Index";
import {
  AIGA_ID,
  RANKED_CANDIDATE_IDS,
  RANKED_START_MS,
  aigaView,
  appErrorOf,
  exitAndAudit,
  openPlay,
  rankedData,
  rankedHarness,
  rankedPool,
  startBotSeries,
  type RankedClient,
  type RankedHarness,
} from "./CEERankedFixtures";
import { character } from "./CEENativeFixtures";

/** 夹具之外还要能单独构造「没装配全」的服务，因此连接也按最小形状手写一份。 */
const bareConnection = (id: string): ConnectionRecord => {
  const clientChannel: ClientChannelProof = {
    clientId: `client-${id}`,
    clientType: "desktop",
    clientVersion: "9.9.9",
    keyProtection: "hardware",
  };
  return {
    id,
    account: { userId: "u1", image: null },
    clientIp: "127.0.0.1",
    clientChannel,
    lobbySubscribed: false,
    send: () => {},
    close: () => {},
  };
};

const bareService = (options: { store?: CEERankedStore; pool?: CEERankedPoolProvider }) =>
  new CEERankedService({
    data: rankedData(rankedPool()),
    provenance: new CEESearchProvenance(() => RANKED_START_MS),
    ...options,
  });

/** 逐条命令断言同一条错误码：漏掉任何一条命令的可用性检查都会被这里抓住。 */
const expectUnavailable = async (
  service: CEERankedService,
  record: ConnectionRecord,
  type: CEERankedCommand,
  payload: CEERankedPayload<CEERankedCommand>
): Promise<void> => {
  const error = await appErrorOf(() =>
    service.execute(record, { id: crypto.randomUUID(), type, payload })
  );
  expect({ type, code: error.code, message: error.message }).toEqual({
    type,
    code: "RANKED_UNAVAILABLE",
    message: "排位赛暂不可用",
  });
};

describe("排位依赖缺席时整体不可用", () => {
  const pool: CEERankedPoolProvider = { getRankedPool: async () => rankedPool() };

  test("没有审计仓储：十三条命令全部回 RANKED_UNAVAILABLE", async () => {
    const service = bareService({ pool });
    const record = bareConnection("no-store");
    service.registerConnection(record);
    await expectUnavailable(service, record, "cee.ranked.status", {});
    await expectUnavailable(service, record, "cee.ranked.queue", {});
    await expectUnavailable(service, record, "cee.ranked.cancel", {});
    await expectUnavailable(service, record, "cee.ranked.playBot", {});
    await expectUnavailable(service, record, "cee.ranked.guess", { characterId: 11 });
    await expectUnavailable(service, record, "cee.ranked.surrender", {});
    await expectUnavailable(service, record, "cee.ranked.exit", {});
    await expectUnavailable(service, record, "cee.ranked.leave", {});
    await expectUnavailable(service, record, "cee.ranked.profile", {});
    await expectUnavailable(service, record, "cee.ranked.characterSearch", { keyword: "角色" });
    await expectUnavailable(service, record, "cee.ranked.subjectSearch", { keyword: "作品" });
    await expectUnavailable(service, record, "cee.ranked.subjectCharacters", { subjectId: 100 });
    await expectUnavailable(service, record, "cee.ranked.characterImage", { characterId: 11 });
    service.close();
  });

  test("没有题库：同样不可用，且不等到开赛前才报", async () => {
    const service = bareService({ store: new InMemoryCEERankedStore() });
    const record = bareConnection("no-pool");
    service.registerConnection(record);
    await expectUnavailable(service, record, "cee.ranked.status", {});
    await expectUnavailable(service, record, "cee.ranked.queue", {});
    service.close();
  });
});

describe("状态查询", () => {
  test("cee.ranked.status 先清掉这条连接的差量基线，随后推的那一帧才能当全量基线", async () => {
    const harness = rankedHarness();
    const client = harness.connect("甲");
    let resets = 0;
    client.record.resetStateSync = () => {
      resets += 1;
    };
    await harness.send(client, "cee.ranked.status", {});
    expect(resets).toBe(1);
    expect(harness.latest(client)).toEqual({ status: "idle" });
  });
});

describe("排队与人机入口", () => {
  test("入队推送 queued 状态：人机可选时刻、兜底时刻与当前窗口一并给出", async () => {
    const harness = rankedHarness();
    const client = harness.connect("甲");
    harness.seedRated(client.userId);
    await harness.send(client, "cee.ranked.status", {});
    expect(harness.latest(client)).toEqual({ status: "idle" });

    await harness.send(client, "cee.ranked.queue", {});
    const queuedAt = harness.clock();
    expect(harness.latest(client)).toEqual({
      status: "queued",
      queuedAt,
      botAvailableAt: queuedAt + CEE_RANKED_BOT_OPTION_MS,
      botFallbackAt: queuedAt + CEE_RANKED_BOT_FALLBACK_MS,
      window: CEE_RANKED_WINDOW_INITIAL,
    });
  });

  test("排队 10 秒内选人机被拒，满 10 秒后开成 manual 人机局", async () => {
    const harness = rankedHarness();
    const client = harness.connect("甲");
    harness.seedRated(client.userId);
    await startBotQueue(harness, client, 9_000);
    const error = await appErrorOf(() => harness.send(client, "cee.ranked.playBot", {}));
    expect({ code: error.code, message: error.message }).toEqual({
      code: "RANKED_BOT_NOT_READY",
      message: "再等一会儿才能选择人机",
    });

    await harness.advance(1_500);
    await harness.send(client, "cee.ranked.playBot", {});
    const view = harness.seriesView(client);
    expect(view.opponent.isBot).toBe(true);
    expect(view.opponent.name).toBe("爱噶");
    // 已定级：状态帧里给出展示分，不再报定级进度。
    expect(view.self.rating).toBe(1500);
    expect(view.self.placementPlayed).toBeNull();
    const audit = await exitAndAudit(harness, client);
    expect(audit.series.botEntry).toBe("manual");
    expect(audit.series.bot).toBe(true);
  });

  test("不操作满 30 秒自动开人机，botEntry 为 auto", async () => {
    const harness = rankedHarness();
    const client = harness.connect("甲");
    harness.seedRated(client.userId);
    await startBotSeries(harness, client);
    expect(harness.seriesView(client).opponent.isBot).toBe(true);
    const audit = await exitAndAudit(harness, client);
    expect(audit.series.botEntry).toBe("auto");
  });

  test("重复入队被拒；取消后回 idle 并停止匹配", async () => {
    const harness = rankedHarness();
    const client = harness.connect("甲");
    harness.seedRated(client.userId);
    await harness.send(client, "cee.ranked.queue", {});
    const error = await appErrorOf(() => harness.send(client, "cee.ranked.queue", {}));
    expect(error.code).toBe("RANKED_ALREADY_QUEUED");

    await harness.send(client, "cee.ranked.cancel", {});
    expect(harness.latest(client)).toEqual({ status: "idle" });
    await harness.advance(120_000);
    expect(harness.latest(client)).toEqual({ status: "idle" });
  });

  test("窗口放宽时给仍在排队的人推新帧", async () => {
    const harness = rankedHarness();
    const client = harness.connect("甲");
    harness.seedRated(client.userId);
    await harness.send(client, "cee.ranked.queue", {});
    const framesBefore = harness.states(client).length;
    await harness.advance(10_000);
    const frames = harness.states(client).slice(framesBefore);
    expect(frames.map((state) => (state.status === "queued" ? state.window : -1))).toEqual([
      CEE_RANKED_WINDOW_INITIAL + 50,
      CEE_RANKED_WINDOW_INITIAL + 100,
    ]);
  });
});

describe("定级赛只打人机", () => {
  test("定级期排队直开人机：一帧 queued 都没有，审计 botEntry 记 placement", async () => {
    const harness = rankedHarness();
    const client = harness.connect("甲");
    await harness.send(client, "cee.ranked.queue", {});
    expect(harness.states(client).map((state) => state.status)).toEqual(["series"]);

    const view = harness.seriesView(client);
    expect(view.opponent.isBot).toBe(true);
    expect(view.self.placementPlayed).toBe(0);

    const audit = await exitAndAudit(harness, client);
    expect(audit.series.botEntry).toBe("placement");
    expect(audit.players.find((player) => player.seat === 0)?.placement).toBe(true);
  });

  test("定级第 5 场结算完，再排队才进人池", async () => {
    const harness = rankedHarness();
    const client = harness.connect("甲");
    harness.seedRated(client.userId, { seriesPlayed: CEE_RANKED_PLACEMENT_SERIES - 1 });
    await harness.send(client, "cee.ranked.queue", {});
    expect(harness.latest(client).status).toBe("series");
    await harness.send(client, "cee.ranked.exit", {});

    await harness.send(client, "cee.ranked.queue", {});
    expect(harness.latest(client).status).toBe("queued");
  });

  test("两名定级期玩家排队不会互相配对，各开各的人机", async () => {
    const harness = rankedHarness();
    const first = harness.connect("甲", { account: { userId: "u1", image: null } });
    const second = harness.connect("乙", { account: { userId: "u2", image: null } });
    await harness.send(first, "cee.ranked.queue", {});
    await harness.send(second, "cee.ranked.queue", {});
    await harness.advance(1_000);

    expect(harness.seriesView(first).opponent.isBot).toBe(true);
    expect(harness.seriesView(second).opponent.isBot).toBe(true);
    expect(harness.seriesView(first).seriesId).not.toBe(harness.seriesView(second).seriesId);
    expect((await exitAndAudit(harness, first)).series.botEntry).toBe("placement");
    expect((await exitAndAudit(harness, second)).series.botEntry).toBe("placement");
  });
});

describe("两名真人配对", () => {
  test("一跳配对开局，双方收到 series 状态且看不到对方猜过的角色名", async () => {
    const harness = rankedHarness({
      resolveName: async (userId) => `昵称-${userId}`,
    });
    const first = harness.connect("甲", { account: { userId: "u1", image: null } });
    const second = harness.connect("乙", { account: { userId: "u2", image: null } });
    harness.seedRated("u1");
    harness.seedRated("u2");
    await harness.send(first, "cee.ranked.queue", {});
    await harness.send(second, "cee.ranked.queue", {});
    await harness.advance(1_000);

    const view = harness.seriesView(first);
    expect(view.opponent.isBot).toBe(false);
    expect(view.opponent.name).toBe("昵称-u2");
    expect(harness.seriesView(second).opponent.name).toBe("昵称-u1");
    expect(view.phase).toBe("countdown");
    expect(view.game?.guesses).toEqual([]);

    await openPlay(harness);
    await harness.send(second, "cee.ranked.guess", { characterId: 15 });
    const json = JSON.stringify(harness.seriesView(first));
    expect(json).not.toContain("Character 15");
    expect(json).not.toContain("角色15");
    const masked = harness.seriesView(first).game?.opponentGuesses;
    expect(masked?.length).toBe(1);
    expect(masked?.[0]?.correct).toBe(false);
    expect(Object.keys(masked?.[0] ?? {})).toEqual(["index", "correct", "createdAt", "feedback"]);
  });

  test("读秒阶段不能猜，开局后才能猜", async () => {
    const harness = rankedHarness();
    const first = harness.connect("甲", { account: { userId: "u1", image: null } });
    const second = harness.connect("乙", { account: { userId: "u2", image: null } });
    harness.seedRated("u1");
    harness.seedRated("u2");
    await harness.send(first, "cee.ranked.queue", {});
    await harness.send(second, "cee.ranked.queue", {});
    await harness.advance(1_000);
    const error = await appErrorOf(() =>
      harness.send(first, "cee.ranked.guess", { characterId: 11 })
    );
    expect(error.code).toBe("INVALID_PHASE");
  });

  test("题库不足三题时不开局：记错误日志并把两人退回 idle", async () => {
    const harness = rankedHarness({ pool: rankedPool(RANKED_CANDIDATE_IDS.slice(0, 2)) });
    const first = harness.connect("甲", { account: { userId: "u1", image: null } });
    const second = harness.connect("乙", { account: { userId: "u2", image: null } });
    harness.seedRated("u1");
    harness.seedRated("u2");
    await harness.send(first, "cee.ranked.queue", {});
    await harness.send(second, "cee.ranked.queue", {});
    await harness.advance(1_000);
    expect(harness.logs.error.map((item) => item.message)).toContain("排位题库不足三题");
    expect(harness.latest(first)).toEqual({ status: "idle" });
    expect(harness.latest(second)).toEqual({ status: "idle" });
  });
});

describe("连接接管与断线", () => {
  test("同账号第二条连接接管推送，旧连接收一帧 idle 后不再收", async () => {
    const harness = rankedHarness();
    const oldClient = harness.connect("旧", { account: { userId: "u1", image: null } });
    const newClient = harness.connect("新", { account: { userId: "u1", image: null } });
    harness.seedRated("u1");
    await harness.send(oldClient, "cee.ranked.status", {});
    expect(harness.states(oldClient)).toEqual([{ status: "idle" }]);

    await harness.send(newClient, "cee.ranked.status", {});
    expect(harness.latest(oldClient)).toEqual({ status: "idle" });
    const oldFrames = harness.states(oldClient).length;

    await harness.send(newClient, "cee.ranked.queue", {});
    expect(harness.states(oldClient).length).toBe(oldFrames);
    expect(harness.latest(newClient).status).toBe("queued");
  });

  test("断线时还在排队就被移出队列，重连后是 idle 而不是继续排", async () => {
    const harness = rankedHarness();
    const client = harness.connect("甲");
    harness.seedRated(client.userId);
    await harness.send(client, "cee.ranked.queue", {});
    client.record.close();
    await harness.advance(120_000);
    const reconnected = harness.connect("甲-重连", {
      account: { userId: client.userId, image: null },
    });
    await harness.send(reconnected, "cee.ranked.status", {});
    expect(harness.latest(reconnected)).toEqual({ status: "idle" });
  });

  test("对局中断线满 90 秒整场判负，endReason 为 offline", async () => {
    const harness = rankedHarness();
    const client = harness.connect("甲");
    await startBotSeries(harness, client);
    const seriesId = harness.seriesView(client).seriesId;
    client.record.close();
    await harness.advance(CEE_RANKED_OFFLINE_FORFEIT_MS + 1_000);

    const audit = await harness.store.getSeriesAudit(seriesId);
    expect(audit?.series.endReason).toBe("offline");
    expect(audit?.players.find((player) => player.seat === 0)?.score).toBe(0);
  });

  test("断线后重连恢复在线，不再判负", async () => {
    const harness = rankedHarness();
    const client = harness.connect("甲");
    await startBotSeries(harness, client);
    const seriesId = harness.seriesView(client).seriesId;
    client.record.close();
    await harness.advance(30_000);
    const reconnected = harness.connect("甲-重连", {
      account: { userId: client.userId, image: null },
    });
    await harness.send(reconnected, "cee.ranked.status", {});
    expect(harness.seriesView(reconnected).self.online).toBe(true);
    await harness.advance(CEE_RANKED_OFFLINE_FORFEIT_MS + 1_000);
    expect(harness.seriesView(reconnected).result).toBeNull();
    expect(await harness.store.getSeriesAudit(seriesId)).toBeNull();
  });

  test("未绑定排位连接的连接只能先走 status", async () => {
    const harness = rankedHarness();
    const client = harness.connect("甲");
    const error = await appErrorOf(() => harness.send(client, "cee.ranked.cancel", {}));
    expect({ code: error.code, message: error.message }).toEqual({
      code: "RANKED_NOT_ATTACHED",
      message: "请重新进入排位",
    });
  });
});

describe("人机开局与爱噶", () => {
  test("爱噶第一手固定猜 132476，视图取自题库外的 extras", async () => {
    const harness = rankedHarness({ extras: [aigaView()] });
    const client = harness.connect("甲");
    await startBotSeries(harness, client);
    await openPlay(harness);
    // 夹具的随机数恒为 0：爱噶每手都顶到 120 秒上限。
    await harness.advance(120_000);
    const audit = await exitAndAudit(harness, client);
    const botGuesses = audit.guesses.filter((guess) => guess.seat === 1);
    expect(botGuesses.map((guess) => guess.characterId)).toEqual([AIGA_ID]);
    expect(botGuesses[0]?.attempt).toBe(1);
    expect(botGuesses[0]?.clientType).toBeNull();
    // 审计里的名字用中文名，英文名为空时才回退。
    expect(botGuesses[0]?.characterName).toBe(`角色${AIGA_ID}`);
    expect(audit.games[0]?.answerName).toBe("角色11");
  });

  test("数据集里没有该角色时跳过这一手，不占人机次数", async () => {
    const harness = rankedHarness();
    const client = harness.connect("甲");
    await startBotSeries(harness, client);
    await openPlay(harness);
    await harness.advance(120_000);
    const audit = await exitAndAudit(harness, client);
    const botGuesses = audit.guesses.filter((guess) => guess.seat === 1);
    // 跳过只推进大脑内部步数：本局只留下一次真实出手，且不是那个取不到视图的编号。
    expect(botGuesses.map((guess) => guess.attempt)).toEqual([1]);
    expect(botGuesses[0]?.characterId).not.toBe(AIGA_ID);
    expect(audit.games[0]?.attempts[1]).toBe(botGuesses.length);
  });
});

describe("审计名称", () => {
  test("中文名为空时退回英文名，答案名不受影响", async () => {
    const harness = rankedHarness({
      data: { getCharacter: async (id) => ({ ...character(id), nameCn: "" }) },
    });
    const client = harness.connect("甲");
    await startBotSeries(harness, client);
    await openPlay(harness);
    await harness.send(client, "cee.ranked.guess", { characterId: 11 });
    const audit = await exitAndAudit(harness, client);
    // 答案视图来自题库，仍带中文名；出手记录现查数据提供者，空的中文名才退回英文名。
    expect(audit.games[0]?.answerName).toBe("角色11");
    expect(audit.guesses[0]?.characterName).toBe("Character 11");
  });
});

describe("排位检索", () => {
  test("没有系列赛时四条检索命令都回 INVALID_PHASE", async () => {
    const harness = rankedHarness();
    const client = harness.connect("甲");
    await harness.send(client, "cee.ranked.status", {});
    for (const [type, payload] of [
      ["cee.ranked.characterSearch", { keyword: "角色" }],
      ["cee.ranked.subjectSearch", { keyword: "作品" }],
      ["cee.ranked.subjectCharacters", { subjectId: 100 }],
      ["cee.ranked.characterImage", { characterId: 11 }],
    ] as const) {
      const error = await appErrorOf(() => harness.send(client, type, payload));
      expect({ type, code: error.code }).toEqual({ type, code: "INVALID_PHASE" });
    }
  });

  test("系列赛内检索可用，先搜后猜会把台账写进审计", async () => {
    const harness = rankedHarness();
    const first = harness.connect("甲", { account: { userId: "u1", image: null } });
    const second = harness.connect("乙", { account: { userId: "u2", image: null } });
    harness.seedRated("u1");
    harness.seedRated("u2");
    await harness.send(first, "cee.ranked.queue", {});
    await harness.send(second, "cee.ranked.queue", {});
    await harness.advance(1_000);
    await openPlay(harness);

    const search = await harness.send(first, "cee.ranked.characterSearch", { keyword: "角色" });
    expect(search.results.map((item) => item.id)).toEqual([...RANKED_CANDIDATE_IDS]);
    const searchedAt = harness.clock();
    // 先让没检索的一方出手：猜中会立刻结束这一局，另一方就没机会在同一局里出手了。
    await harness.send(second, "cee.ranked.guess", { characterId: 12 });
    await harness.send(first, "cee.ranked.guess", { characterId: 11 });

    const audit = await exitAndAudit(harness, first);
    const self = audit.guesses.find((guess) => guess.seat === 0);
    const other = audit.guesses.find((guess) => guess.seat === 1);
    expect(self?.searchedAt).toBe(searchedAt);
    expect(self?.searchMatched).toBe(true);
    expect(other?.searchedAt).toBeNull();
    expect(other?.searchMatched).toBe(false);
    expect(self?.clientType).toBe("desktop");
  });

  test("结算后离开结果页回 idle，未结算时离开被拒", async () => {
    const harness = rankedHarness();
    const client = harness.connect("甲");
    await startBotSeries(harness, client);
    const error = await appErrorOf(() => harness.send(client, "cee.ranked.leave", {}));
    expect(error.code).toBe("INVALID_PHASE");
    await harness.send(client, "cee.ranked.exit", {});
    expect(harness.seriesView(client).result?.settlement).toBe("rated");
    await harness.send(client, "cee.ranked.leave", {});
    expect(harness.latest(client)).toEqual({ status: "idle" });
  });
});

describe("协议接线", () => {
  test("parseCEEMessage 接受合法的排位猜测信封，拒绝多余字段与越界编号", () => {
    const parsed = parseCEEMessage({
      id: "m1",
      type: "cee.ranked.guess",
      payload: { characterId: 11 },
    });
    expect(parsed.type).toBe("cee.ranked.guess");

    expect(() =>
      parseCEEMessage({
        id: "m1",
        type: "cee.ranked.guess",
        payload: { characterId: 11, extra: 1 },
      })
    ).toThrow();
    expect(() =>
      parseCEEMessage({
        id: "m1",
        type: "cee.ranked.guess",
        payload: { characterId: 11 },
        extra: 1,
      })
    ).toThrow();
    expect(() =>
      parseCEEMessage({ id: "m1", type: "cee.ranked.guess", payload: { characterId: 0 } })
    ).toThrow();
  });

  test("CEEService 把 cee.ranked.* 交给排位服务，房间命令行为不变", async () => {
    const clock = RANKED_START_MS;
    const pool = rankedPool();
    const service = new CEEService({
      data: rankedData(pool),
      now: () => clock,
      random: () => 0,
      eventLogger: new EventLogger(() => {}),
      rankedStore: new InMemoryCEERankedStore(),
      rankedPool: { getRankedPool: async () => pool },
    });
    const record = bareConnection("entry-1");
    service.registerConnection(record);

    expect(await service.execute(record.id, rankedMessage("cee.ranked.status", {}))).toEqual({
      status: "idle",
    });
    const roomSearch = await appErrorOf(() =>
      service.execute(record.id, {
        id: "m2",
        type: "cee.character.search",
        roomId: "1234",
        payload: { keyword: "角色" },
      })
    );
    expect(roomSearch.code).toBe("ROOM_NOT_FOUND");

    const codes: string[] = [];
    for (let index = 0; index <= CEE_SEARCH_CONNECTION_MAX; index += 1) {
      try {
        await service.execute(
          record.id,
          rankedMessage("cee.ranked.characterSearch", { keyword: "角色" }, `s${index}`)
        );
        codes.push("ok");
      } catch (error) {
        codes.push(error instanceof AppError ? error.code : "unknown");
      }
    }
    // 未开局时排位检索回 INVALID_PHASE，扣掉的额度与增强房同一个桶：
    // 前面那次房间检索已经占走一份，所以通过数比整桶少一次。
    expect(codes).toEqual([
      ...Array.from({ length: CEE_SEARCH_CONNECTION_MAX - 1 }, () => "INVALID_PHASE"),
      "RATE_LIMITED",
      "RATE_LIMITED",
    ]);
    await service.close();
  });
});

const rankedMessage = <T extends CEERankedCommand>(
  type: T,
  payload: CEERankedPayload<T>,
  id: string = crypto.randomUUID()
) => ({ id, type, payload });

/** 排队并停在「还没到人机可选时刻」之前：给用例留出被拒的时间点。 */
async function startBotQueue(
  harness: RankedHarness,
  client: RankedClient,
  advanceMs: number
): Promise<void> {
  await harness.send(client, "cee.ranked.queue", {});
  await harness.advance(advanceMs);
}
