import { afterAll, beforeAll, describe, expect, test } from "bun:test";

import { TEST_ROOMS_DISABLED } from "../../src/domain/TestRooms";
import {
  SensitiveTextFilter,
  setSensitiveTextFilterForTest,
} from "../../src/infrastructure/SensitiveText";
import type { WhoIsFakerClientMessage, WhoIsFakerPhase } from "../../src/shared/Index";
import { createConnection, createTestContext, execute, type TestConnection } from "../Helpers";
import { createRoom, joinPlayers, type JoinedPlayer } from "./Fixtures";

/**
 * 命令守卫的先后顺序：同时违反两条规则的请求拿到哪个错误码，由守卫顺序决定。
 * 这里只通过公开的 execute 入口断言对外可见的错误码与文案，命令分发怎么组织都不能改变它们。
 */

// 只用占位词：测试文件里不出现真实敏感词。
const BAD = "测试违禁词A";
beforeAll(() => setSensitiveTextFilterForTest(new SensitiveTextFilter([BAD])));
afterAll(() => setSensitiveTextFilterForTest(undefined));

type Failure = { code: string; message: string };

const NOT_IN_ROOM = { code: "PLAYER_NOT_IN_ROOM", message: "当前连接尚未加入房间" };
const NOT_HOST = { code: "FORBIDDEN", message: "只有房主可以执行该操作" };
const NOT_QUESTIONER = { code: "FORBIDDEN", message: "只有出题人可以执行该操作" };
const NO_ROUND = { code: "ROUND_NOT_STARTED", message: "当前房间尚未开始游戏" };

/** 普通房：房主加四名玩家并全部准备，出题人是最后一名玩家，可按需推进到描述阶段。 */
const setup = async () => {
  const { service } = createTestContext();
  const { host, result } = await createRoom(service, "1616");
  const joined = await joinPlayers(service, "1616", 4, "玩家");
  for (const connection of [host, ...joined.map((item) => item.connection)]) {
    await execute(service, connection, {
      id: `ready-${connection.record.id}`,
      type: "player.setReady",
      payload: { ready: true },
    });
  }
  const room = service.rooms.get("1616")!;
  const questioner = joined[3]!;
  const guest = joined[0]!;
  let seq = 0;
  const send = (who: TestConnection, type: string, payload: Record<string, unknown> = {}) =>
    execute(service, who, {
      id: `g-${(seq += 1)}`,
      type,
      payload,
    } as WhoIsFakerClientMessage);
  const rejected = async (
    who: TestConnection,
    type: string,
    payload: Record<string, unknown> = {}
  ): Promise<Failure> => {
    try {
      await send(who, type, payload);
    } catch (error) {
      return error as Failure;
    }
    throw new Error(`${type} 应被拒绝`);
  };
  // 只向前推进：已经走过的步骤不重复执行。
  const toPhase = async (phase: "assigningQuestioner" | "wordSubmission" | "description") => {
    if (!room.round) await send(host, "game.advancePhase");
    if (phase === "assigningQuestioner") return;
    if (!room.round!.questionerPlayerId) {
      await send(host, "game.assignQuestioner", { playerId: questioner.joinResult.playerId });
    }
    if (phase === "wordSubmission") return;
    if (!room.round!.words) {
      await send(questioner.connection, "game.submitWords", { words: ["苹果", "香蕉"] });
    }
  };
  const setPhase = (phase: WhoIsFakerPhase) => {
    room.round!.phase = phase;
  };
  return {
    service,
    host,
    hostId: result.playerId,
    joined,
    guest,
    questioner,
    room,
    send,
    rejected,
    toPhase,
    setPhase,
  };
};

const SEAT_COMMANDS: Array<[string, Record<string, unknown>]> = [
  ["room.leave", {}],
  ["room.requestSync", {}],
  ["room.updateSettings", {}],
  ["room.kick", { playerId: "x" }],
  ["room.transferHost", { playerId: "x" }],
  ["chat.send", { text: "你好" }],
  ["player.rename", { name: "新名" }],
  ["player.setSpectator", { spectator: true }],
  ["player.setReady", { ready: true }],
  ["game.assignQuestioner", { playerId: "x" }],
  ["game.submitWords", { words: ["甲", "乙"] }],
  ["game.advancePhase", {}],
  ["game.submitDescription", { text: "描述" }],
  ["game.submitVote", { targetId: "x" }],
  ["game.submitNightAction", { targetId: "x" }],
  ["game.submitBlankGuess", { words: ["甲", "乙"] }],
  ["game.enterBlankGuess", {}],
  ["game.updateBlankGuessDraft", { words: ["甲", "乙"] }],
  ["game.reviewBlankGuess", { approve: true }],
  ["game.cancelVote", {}],
  ["game.cancelNightAction", {}],
  ["game.requestSupplement", { playerIds: ["x"] }],
  ["game.resolveDisconnect", { playerId: "x", resolution: "wait" }],
  ["game.startPhaseTimer", { durationSeconds: 60 }],
  ["game.stopPhaseTimer", {}],
  ["test.jumpToPhase", { phase: "waiting" }],
  ["test.setMyRole", { role: "civilian" }],
  ["test.addBot", { count: 1 }],
  ["test.removeBot", { count: 1 }],
];

describe("命令守卫顺序：身份先于一切守卫", () => {
  test("未入房的连接发任何座位命令都先得到未入房", async () => {
    const { service, rejected } = await setup();
    const outsider = createConnection(service, "outsider");
    for (const [type, payload] of SEAT_COMMANDS) {
      expect(await rejected(outsider, type, payload)).toMatchObject(NOT_IN_ROOM);
    }
  });

  test("房间已不存在时先得到房间不存在，房主命令也不例外", async () => {
    const { service, host, rejected } = await setup();
    service.ctx.rooms.delete("1616");
    for (const type of ["room.updateSettings", "game.advancePhase", "room.leave", "test.addBot"]) {
      expect(await rejected(host, type, {})).toMatchObject({
        code: "ROOM_NOT_FOUND",
        message: "房间不存在",
      });
    }
  });

  test("大厅命令不要求入房", async () => {
    const { service, send } = await setup();
    const outsider = createConnection(service, "lobby-watcher");
    expect(await send(outsider, "lobby.subscribeRooms")).toEqual({ subscribed: true });
  });

  test("不认识的命令一律当作不支持，原型上的名字也不例外", async () => {
    const { host, rejected } = await setup();
    for (const type of ["nope.nothing", "constructor", "toString", "__proto__"]) {
      expect(await rejected(host, type)).toMatchObject({
        code: "UNSUPPORTED_COMMAND",
        message: "暂不支持的命令",
      });
    }
  });
});

describe("命令守卫顺序：参数预检先于身份", () => {
  test("白板猜词与草稿的敏感词检测排在认座位之前", async () => {
    const { service, rejected } = await setup();
    const outsider = createConnection(service, "outsider");
    for (const type of ["game.submitBlankGuess", "game.updateBlankGuessDraft"]) {
      expect(await rejected(outsider, type, { words: [BAD, "乙"] })).toMatchObject({
        code: "TEXT_SENSITIVE",
      });
      expect(await rejected(outsider, type, { words: ["甲", BAD] })).toMatchObject({
        code: "TEXT_SENSITIVE",
      });
    }
  });

  test("倒计时时长的合法性排在认座位之前", async () => {
    const { service, rejected } = await setup();
    const outsider = createConnection(service, "outsider");
    expect(await rejected(outsider, "game.startPhaseTimer", { durationSeconds: 90 })).toMatchObject(
      { code: "INVALID_ARGUMENT", message: "倒计时时长只能在1、2、3分钟之间选择" }
    );
  });

  test("入房者同样先得到参数错误，其次才是回合与出题人判定", async () => {
    const { guest, rejected } = await setup();
    // 没有回合、也不是出题人：时长错误排在最前，白板猜词的敏感词排在回合判定之前。
    expect(
      await rejected(guest.connection, "game.startPhaseTimer", { durationSeconds: 5 })
    ).toMatchObject({ code: "INVALID_ARGUMENT" });
    expect(
      await rejected(guest.connection, "game.submitBlankGuess", { words: [BAD, "乙"] })
    ).toMatchObject({ code: "TEXT_SENSITIVE" });
    expect(
      await rejected(guest.connection, "game.submitBlankGuess", { words: ["甲", "乙"] })
    ).toMatchObject(NO_ROUND);
  });
});

describe("命令守卫顺序：房主先于回合、阶段与目标", () => {
  test("非房主的房主命令先被拒为 FORBIDDEN，即使同时违反别的规则", async () => {
    const { guest, joined, rejected, setPhase, toPhase } = await setup();
    const whom = guest.connection;
    // 无回合：设置、踢人、转让、指定出题人都先看房主。
    expect(await rejected(whom, "room.updateSettings", {})).toMatchObject(NOT_HOST);
    expect(
      await rejected(whom, "room.kick", { playerId: guest.joinResult.playerId })
    ).toMatchObject(NOT_HOST);
    expect(
      await rejected(whom, "room.transferHost", { playerId: guest.joinResult.playerId })
    ).toMatchObject(NOT_HOST);
    expect(
      await rejected(whom, "game.assignQuestioner", { playerId: joined[1]!.joinResult.playerId })
    ).toMatchObject(NOT_HOST);
    // 有回合且在别的阶段：设置与指定出题人仍先看房主，而不是回合进行中或阶段不符。
    await toPhase("description");
    expect(await rejected(whom, "room.updateSettings", {})).toMatchObject(NOT_HOST);
    expect(
      await rejected(whom, "game.assignQuestioner", { playerId: joined[1]!.joinResult.playerId })
    ).toMatchObject(NOT_HOST);
    setPhase("voting");
    expect(await rejected(whom, "room.updateSettings", {})).toMatchObject(NOT_HOST);
  });

  test("房主自己违反两条规则时拿到靠前那条", async () => {
    const { host, hostId, joined, rejected, setPhase, toPhase } = await setup();
    // 无回合：先是回合未开始，而不是阶段不符。
    expect(
      await rejected(host, "game.assignQuestioner", { playerId: joined[0]!.joinResult.playerId })
    ).toMatchObject(NO_ROUND);
    await toPhase("description");
    expect(
      await rejected(host, "game.assignQuestioner", { playerId: joined[0]!.joinResult.playerId })
    ).toMatchObject({ code: "INVALID_PHASE", message: "当前阶段不能指定出题人" });
    // 回合进行中：设置被拒为回合进行中，而不是先去校验各字段。
    expect(await rejected(host, "room.updateSettings", { name: "   " })).toMatchObject({
      code: "ROUND_ACTIVE",
      message: "游戏进行中无法修改房间设置",
    });
    setPhase("gameOver");
    expect(await rejected(host, "room.updateSettings", { name: "   " })).toMatchObject({
      code: "INVALID_ROOM_NAME",
    });
    // 踢人与转让：房主判定之后先是自己，再是目标是否存在。
    expect(await rejected(host, "room.kick", { playerId: hostId })).toMatchObject({
      code: "INVALID_KICK",
    });
    expect(await rejected(host, "room.kick", { playerId: "nobody" })).toMatchObject({
      code: "PLAYER_NOT_FOUND",
      message: "目标玩家不存在",
    });
    expect(await rejected(host, "room.transferHost", { playerId: hostId })).toMatchObject({
      code: "INVALID_TARGET",
    });
    expect(await rejected(host, "room.transferHost", { playerId: "nobody" })).toMatchObject({
      code: "PLAYER_NOT_FOUND",
    });
  });

  test("推进阶段：等待与结算阶段看房主，其余阶段看出题人", async () => {
    const { guest, host, questioner, rejected, setPhase, toPhase } = await setup();
    expect(await rejected(guest.connection, "game.advancePhase")).toMatchObject(NOT_HOST);
    await toPhase("description");
    expect(await rejected(guest.connection, "game.advancePhase")).toMatchObject(NOT_QUESTIONER);
    expect(await rejected(host, "game.advancePhase")).toMatchObject(NOT_QUESTIONER);
    setPhase("gameOver");
    expect(await rejected(guest.connection, "game.advancePhase")).toMatchObject(NOT_HOST);
    expect(await rejected(questioner.connection, "game.advancePhase")).toMatchObject(NOT_HOST);
  });
});

describe("命令守卫顺序：回合与出题人先于阶段与参数", () => {
  test("提交词语：回合 → 出题人 → 阶段 → 敏感词", async () => {
    const { guest, questioner, rejected, toPhase } = await setup();
    expect(
      await rejected(questioner.connection, "game.submitWords", { words: ["a", "b"] })
    ).toMatchObject(NO_ROUND);
    await toPhase("assigningQuestioner");
    // 不是出题人且阶段也不对：先是出题人。
    expect(
      await rejected(guest.connection, "game.submitWords", { words: [BAD, "b"] })
    ).toMatchObject(NOT_QUESTIONER);
    await toPhase("wordSubmission");
    expect(
      await rejected(guest.connection, "game.submitWords", { words: [BAD, "b"] })
    ).toMatchObject(NOT_QUESTIONER);
    // 出题人在对的阶段：敏感词；换成错的阶段则先是阶段。
    expect(
      await rejected(questioner.connection, "game.submitWords", { words: [BAD, "b"] })
    ).toMatchObject({ code: "TEXT_SENSITIVE" });
    await toPhase("description");
    expect(
      await rejected(questioner.connection, "game.submitWords", { words: [BAD, "b"] })
    ).toMatchObject({ code: "INVALID_PHASE", message: "当前阶段不能提交词语" });
  });

  test("白板裁定、发起补充、处理掉线：回合 → 出题人 → 各自的判定", async () => {
    const { guest, questioner, rejected, toPhase } = await setup();
    const commands: Array<[string, Record<string, unknown>]> = [
      ["game.reviewBlankGuess", { approve: true }],
      ["game.requestSupplement", { playerIds: ["x"] }],
      ["game.resolveDisconnect", { playerId: "x", resolution: "wait" }],
    ];
    for (const [type, payload] of commands) {
      expect(await rejected(questioner.connection, type, payload)).toMatchObject(NO_ROUND);
      expect(await rejected(guest.connection, type, payload)).toMatchObject(NO_ROUND);
    }
    await toPhase("wordSubmission");
    for (const [type, payload] of commands) {
      expect(await rejected(guest.connection, type, payload)).toMatchObject(NOT_QUESTIONER);
    }
    expect(
      await rejected(questioner.connection, "game.reviewBlankGuess", { approve: true })
    ).toMatchObject({ code: "ACTION_FORBIDDEN", message: "当前没有待裁定的白板猜词" });
    expect(
      await rejected(questioner.connection, "game.requestSupplement", { playerIds: ["x"] })
    ).toMatchObject({ code: "INVALID_PHASE" });
    expect(
      await rejected(questioner.connection, "game.resolveDisconnect", {
        playerId: "x",
        resolution: "wait",
      })
    ).toMatchObject({ code: "PLAYER_NOT_PENDING" });
  });

  test("夜晚与撤销：回合 → 阶段", async () => {
    const { guest, rejected, toPhase } = await setup();
    for (const [type, payload] of [
      ["game.submitNightAction", { targetId: "x" }],
      ["game.cancelNightAction", {}],
      ["game.cancelVote", {}],
      ["game.submitVote", { targetId: "x" }],
      ["game.submitDescription", { text: "描述" }],
    ] as Array<[string, Record<string, unknown>]>) {
      expect(await rejected(guest.connection, type, payload)).toMatchObject(NO_ROUND);
    }
    await toPhase("description");
    expect(
      await rejected(guest.connection, "game.submitNightAction", { targetId: "x" })
    ).toMatchObject({ code: "INVALID_PHASE", message: "当前阶段不能提交夜晚操作" });
    expect(await rejected(guest.connection, "game.cancelNightAction")).toMatchObject({
      code: "INVALID_PHASE",
      message: "当前阶段不能撤销夜晚操作",
    });
    expect(await rejected(guest.connection, "game.cancelVote")).toMatchObject({
      code: "INVALID_PHASE",
      message: "当前阶段不能撤销投票",
    });
    expect(await rejected(guest.connection, "game.submitVote", { targetId: "x" })).toMatchObject({
      code: "INVALID_PHASE",
      message: "当前阶段不能提交投票",
    });
  });

  test("提交描述：回合 → 空内容 → 敏感词 → 阶段", async () => {
    const { guest, rejected, toPhase, setPhase } = await setup();
    expect(
      await rejected(guest.connection, "game.submitDescription", { text: "   " })
    ).toMatchObject(NO_ROUND);
    await toPhase("description");
    expect(
      await rejected(guest.connection, "game.submitDescription", { text: "   " })
    ).toMatchObject({ code: "INVALID_DESCRIPTION", message: "描述不能为空" });
    setPhase("night");
    expect(await rejected(guest.connection, "game.submitDescription", { text: BAD })).toMatchObject(
      { code: "TEXT_SENSITIVE" }
    );
    expect(
      await rejected(guest.connection, "game.submitDescription", { text: "正常描述" })
    ).toMatchObject({ code: "INVALID_PHASE", message: "当前阶段不能提交描述" });
  });

  test("白板猜词：敏感词 → 回合 → 身份", async () => {
    const { guest, rejected, toPhase } = await setup();
    expect(await rejected(guest.connection, "game.enterBlankGuess")).toMatchObject(NO_ROUND);
    await toPhase("description");
    expect(
      await rejected(guest.connection, "game.submitBlankGuess", { words: [BAD, "乙"] })
    ).toMatchObject({ code: "TEXT_SENSITIVE" });
    expect(
      await rejected(guest.connection, "game.submitBlankGuess", { words: ["甲", "乙"] })
    ).toMatchObject({ code: "ACTION_FORBIDDEN", message: "只有白板可以猜词" });
    expect(
      await rejected(guest.connection, "game.updateBlankGuessDraft", { words: ["甲", "乙"] })
    ).toMatchObject({ code: "ACTION_FORBIDDEN", message: "当前不能更新猜词内容" });
    expect(await rejected(guest.connection, "game.enterBlankGuess")).toMatchObject({
      code: "ACTION_FORBIDDEN",
      message: "只有白板可以猜词",
    });
  });
});

describe("命令守卫顺序：倒计时的阶段先于出题人", () => {
  test("正式房间：回合 → 阶段 → 出题人 → 阻塞", async () => {
    const { guest, questioner, rejected, toPhase, setPhase, room } = await setup();
    expect(
      await rejected(guest.connection, "game.startPhaseTimer", { durationSeconds: 60 })
    ).toMatchObject(NO_ROUND);
    expect(await rejected(guest.connection, "game.stopPhaseTimer")).toMatchObject(NO_ROUND);
    await toPhase("wordSubmission");
    // 非出题人在不支持倒计时的阶段：先得到阶段错误，不是出题人错误。
    for (const phase of [
      "assigningQuestioner",
      "wordSubmission",
      "feedback",
      "gameOver",
    ] as const) {
      setPhase(phase);
      expect(
        await rejected(guest.connection, "game.startPhaseTimer", { durationSeconds: 60 })
      ).toMatchObject({ code: "INVALID_PHASE", message: "当前阶段不支持设置倒计时" });
    }
    setPhase("wordSubmission");
    await toPhase("description");
    expect(
      await rejected(guest.connection, "game.startPhaseTimer", { durationSeconds: 60 })
    ).toMatchObject(NOT_QUESTIONER);
    expect(await rejected(guest.connection, "game.stopPhaseTimer")).toMatchObject(NOT_QUESTIONER);
    // 出题人通过出题人判定后才轮到阻塞判定。
    room.round!.questionerReconnectDeadlineAt = 1;
    expect(
      await rejected(questioner.connection, "game.startPhaseTimer", { durationSeconds: 60 })
    ).toMatchObject({ code: "QUESTIONER_PENDING" });
  });

  test("测试房间：任何房内成员都可以开关倒计时，阶段判定依旧在前", async () => {
    const { service } = createTestContext();
    const { host } = await createRoom(service, "Oblivionis");
    const [other] = await joinPlayers(service, "Oblivionis", 1, "路人");
    await execute(service, host, { id: "a", type: "test.addBot", payload: { count: 3 } });
    await execute(service, host, {
      id: "j",
      type: "test.jumpToPhase",
      payload: { phase: "description" },
    });
    const started = await execute(service, other!.connection, {
      id: "t1",
      type: "game.startPhaseTimer",
      payload: { durationSeconds: 60 },
    });
    expect(started).toMatchObject({ phaseTimer: { durationSeconds: 60, phase: "description" } });
    expect(
      await execute(service, other!.connection, {
        id: "t2",
        type: "game.stopPhaseTimer",
        payload: {},
      })
    ).toEqual({ stopped: true });
    service.rooms.get("Oblivionis")!.round!.phase = "gameOver";
    await expect(
      execute(service, other!.connection, {
        id: "t3",
        type: "game.startPhaseTimer",
        payload: { durationSeconds: 60 },
      })
    ).rejects.toMatchObject({ code: "INVALID_PHASE", message: "当前阶段不支持设置倒计时" });
  });
});

describe("命令守卫顺序：玩家命令", () => {
  test("切换旁观：被移出 → 回合进行中 → 不允许旁观", async () => {
    const { guest, room, rejected, toPhase } = await setup();
    room.settings.allowSpectators = false;
    // 不允许旁观且在局外：只剩最后一条。
    expect(
      await rejected(guest.connection, "player.setSpectator", { spectator: true })
    ).toMatchObject({ code: "SPECTATOR_DISABLED", message: "当前房间不允许旁观" });
    await toPhase("description");
    expect(
      await rejected(guest.connection, "player.setSpectator", { spectator: true })
    ).toMatchObject({ code: "ROUND_ACTIVE", message: "游戏进行中无法切换阵营" });
    room.players[guest.joinResult.playerId]!.membership = "kicked";
    expect(
      await rejected(guest.connection, "player.setSpectator", { spectator: true })
    ).toMatchObject({ code: "PLAYER_KICKED", message: "该玩家已被移出房间" });
  });

  test("切换准备：回合进行中被拒", async () => {
    const { guest, rejected, toPhase } = await setup();
    await toPhase("description");
    expect(await rejected(guest.connection, "player.setReady", { ready: false })).toMatchObject({
      code: "ROUND_ACTIVE",
      message: "游戏进行中无法切换准备状态",
    });
  });

  test("改名：空名 → 同名直接返回 → 敏感词 → 重名", async () => {
    const { guest, joined, rejected, send } = await setup();
    expect(await rejected(guest.connection, "player.rename", { name: "   " })).toMatchObject({
      code: "INVALID_NAME",
      message: "用户名不能为空",
    });
    expect(await send(guest.connection, "player.rename", { name: "玩家1" })).toEqual({
      name: "玩家1",
    });
    expect(await rejected(guest.connection, "player.rename", { name: BAD })).toMatchObject({
      code: "TEXT_SENSITIVE",
    });
    expect(await rejected(guest.connection, "player.rename", { name: "玩家2" })).toMatchObject({
      code: "NAME_CONFLICT",
    });
    void joined;
  });

  test("聊天：限流先于空内容判定", async () => {
    const { guest, rejected, send } = await setup();
    let limited: Failure | undefined;
    for (let index = 0; index < 200 && !limited; index += 1) {
      try {
        await send(guest.connection, "chat.send", { text: "你好" });
      } catch (error) {
        limited = error as Failure;
      }
    }
    expect(limited?.code).toBe("RATE_LIMITED");
    expect(await rejected(guest.connection, "chat.send", { text: "   " })).toMatchObject({
      code: "RATE_LIMITED",
    });
  });
});

describe("命令守卫顺序：测试指令先问策略再验房主", () => {
  const TEST_COMMANDS: Array<[string, Record<string, unknown>]> = [
    ["test.jumpToPhase", { phase: "waiting" }],
    ["test.setMyRole", { role: "civilian" }],
    ["test.addBot", { count: 1 }],
    ["test.removeBot", { count: 1 }],
  ];

  test("非测试房：房主与非房主都拿到不支持，不给探测者区分开关与房间的信号", async () => {
    const { host, guest, rejected } = await setup();
    for (const [type, payload] of TEST_COMMANDS) {
      for (const who of [host, guest.connection]) {
        expect(await rejected(who, type, payload)).toMatchObject({
          code: "UNSUPPORTED_COMMAND",
          message: "暂不支持的命令",
        });
      }
    }
  });

  test("策略关闭：连测试房号都建不出来，测试指令同样不支持", async () => {
    const { service } = createTestContext({ testRooms: TEST_ROOMS_DISABLED });
    const { host } = await createRoom(service, "5656");
    await expect(
      execute(service, host, { id: "t", type: "test.addBot", payload: { count: 1 } })
    ).rejects.toMatchObject({ code: "UNSUPPORTED_COMMAND" });
  });

  test("测试房：非房主被拒为 FORBIDDEN，房主放行", async () => {
    const { service } = createTestContext();
    const { host } = await createRoom(service, "Oblivionis");
    const joined: JoinedPlayer[] = await joinPlayers(service, "Oblivionis", 1, "路人");
    const other = joined[0]!.connection;
    for (const [type, payload] of TEST_COMMANDS) {
      await expect(
        execute(service, other, { id: `x-${type}`, type, payload } as WhoIsFakerClientMessage)
      ).rejects.toMatchObject(NOT_HOST);
    }
    expect(
      await execute(service, host, { id: "ok", type: "test.addBot", payload: { count: 1 } })
    ).toMatchObject({ added: [expect.any(String)] });
  });
});

describe("命令守卫顺序：被拒的命令不产生下行帧", () => {
  test("守卫拒绝后房主与旁人都没有收到新帧", async () => {
    const { guest, host, joined, rejected, toPhase } = await setup();
    await toPhase("description");
    const watchers = [host, ...joined.map((item) => item.connection)];
    const before = watchers.map((item) => item.sent.length);
    await rejected(guest.connection, "room.updateSettings", {});
    await rejected(guest.connection, "game.assignQuestioner", { playerId: "x" });
    await rejected(guest.connection, "game.submitWords", { words: ["a", "b"] });
    await rejected(guest.connection, "game.startPhaseTimer", { durationSeconds: 60 });
    await rejected(guest.connection, "test.addBot", { count: 1 });
    expect(watchers.map((item) => item.sent.length)).toEqual(before);
  });
});
