import { describe, expect, test } from "bun:test";
import { type JoinedPlayer, createRoom } from "./Fixtures";
import { type WhoIsFakerPrivateState, type WhoIsFakerRoomSnapshot } from "../../src/shared/Index";
import {
  createConnection,
  createTestContext,
  execute,
  getEventPayloads,
  getLastEventPayload,
} from ".././Helpers";

describe("角色可见性与房主", () => {
  test("4 名正式玩家且无旁观者时不能开始游戏", async () => {
    const { service } = createTestContext();
    const { host } = await createRoom(service, "5656");

    for (let index = 0; index < 3; index += 1) {
      const connection = createConnection(service, `min-join-${index}`);
      await execute(service, connection, {
        id: `min-join-${index}`,
        type: "room.join",
        roomId: "5656",
        payload: {
          userName: `最小玩家${index + 2}`,
        },
      });
      await execute(service, connection, {
        id: `min-ready-${index}`,
        type: "player.setReady",
        payload: { ready: true },
      });
    }

    await execute(service, host, {
      id: "host-ready",
      type: "player.setReady",
      payload: { ready: true },
    });

    let errorCode: string | undefined;
    try {
      await execute(service, host, {
        id: "start",
        type: "game.advancePhase",
        payload: {},
      });
    } catch (error) {
      errorCode = (error as { code?: string }).code;
    }

    expect(errorCode).toBe("INSUFFICIENT_PLAYERS");
  });

  test("旁观者不会阻塞准备且可以作为 4 名正式玩家房间的出题人", async () => {
    const { service } = createTestContext();
    const { host } = await createRoom(service, "5757");
    const joined: JoinedPlayer[] = [];

    for (let index = 0; index < 4; index += 1) {
      const connection = createConnection(service, `spec-join-${index}`);
      const joinResult = (await execute(service, connection, {
        id: `spec-join-${index}`,
        type: "room.join",
        roomId: "5757",
        payload: {
          userName: `旁观测试${index + 2}`,
        },
      })) as { playerId: string };
      joined.push({ connection, joinResult });
    }

    await execute(service, joined[3].connection, {
      id: "set-spectator",
      type: "player.setSpectator",
      payload: { spectator: true },
    });

    for (const connection of [
      host,
      joined[0].connection,
      joined[1].connection,
      joined[2].connection,
    ]) {
      await execute(service, connection, {
        id: `ready-${connection.record.id}`,
        type: "player.setReady",
        payload: { ready: true },
      });
    }

    await execute(service, host, { id: "start", type: "game.advancePhase", payload: {} });
    await execute(service, host, {
      id: "assign-spectator",
      type: "game.assignQuestioner",
      payload: { playerId: joined[3].joinResult.playerId },
    });

    const snapshot = getLastEventPayload<WhoIsFakerRoomSnapshot>(host, "room.snapshot");
    expect(snapshot?.status.phase).toBe("wordSubmission");
    expect(snapshot?.status.questionerPlayerId).toBe(joined[3].joinResult.playerId);
  });

  test("开启 spectatorsSeeAnswers 后旁观者在局内可以看到所有玩家身份", async () => {
    // 默认关闭（局中不下发答案与身份），口径见 WhoIsFakerSpectatorAnswers.test.ts；
    // 这里验证房主打开开关时保持原有的旁观上帝视角。
    const { service } = createTestContext();
    const { host, result: hostResult } = await createRoom(service, "5858");
    await execute(service, host, {
      id: "enable-spectator-answers",
      type: "room.updateSettings",
      payload: { spectatorsSeeAnswers: true },
    });
    const joined: JoinedPlayer[] = [];

    for (let index = 0; index < 5; index += 1) {
      const connection = createConnection(service, `view-join-${index}`);
      const joinResult = (await execute(service, connection, {
        id: `view-join-${index}`,
        type: "room.join",
        roomId: "5858",
        payload: {
          userName: `身份视图${index + 2}`,
        },
      })) as { playerId: string };
      joined.push({ connection, joinResult });
    }

    const spectator = joined[4];
    await execute(service, spectator.connection, {
      id: "set-spectator",
      type: "player.setSpectator",
      payload: { spectator: true },
    });

    for (const connection of [host, ...joined.slice(0, 4).map((item) => item.connection)]) {
      await execute(service, connection, {
        id: `ready-${connection.record.id}`,
        type: "player.setReady",
        payload: { ready: true },
      });
    }

    await execute(service, host, { id: "start", type: "game.advancePhase", payload: {} });
    await execute(service, host, {
      id: "assign",
      type: "game.assignQuestioner",
      payload: { playerId: joined[3].joinResult.playerId },
    });
    await execute(service, joined[3].connection, {
      id: "words",
      type: "game.submitWords",
      payload: { words: ["苹果", "香蕉"] },
    });

    const privateState = getLastEventPayload<WhoIsFakerPrivateState>(
      spectator.connection,
      "game.privateState"
    );
    expect(privateState?.isQuestioner).toBe(false);
    expect(privateState?.role).toBeUndefined();
    expect(privateState?.side).toBeUndefined();
    expect(privateState?.word).toBeUndefined();
    expect(privateState?.angelWordOptions).toBeUndefined();
    expect(privateState?.blankHint).toBeUndefined();
    expect(privateState?.questionerView).toHaveLength(4);

    // 已能看到全部身份的视角才拿到全局词语；参战玩家仍只知道自己那一个。
    expect(privateState?.globalWords).toEqual({
      civilianWord: expect.any(String),
      undercoverWord: expect.any(String),
      blankHint: undefined,
    });
    expect(
      getLastEventPayload<WhoIsFakerPrivateState>(joined[3].connection, "game.privateState")
        ?.globalWords
    ).toEqual(privateState?.globalWords);
    expect(
      getLastEventPayload<WhoIsFakerPrivateState>(host, "game.privateState")?.globalWords
    ).toBeUndefined();
    expect(privateState?.questionerView?.every((entry) => entry.role != null)).toBe(true);
    expect(
      privateState?.questionerView?.some(
        (entry) => entry.playerId === spectator.joinResult.playerId
      )
    ).toBe(false);

    const connectionByPlayerId = new Map<string, ReturnType<typeof createConnection>>([
      [hostResult.playerId, host],
      ...joined.map((item) => [item.joinResult.playerId, item.connection] as const),
    ]);
    for (const player of privateState?.questionerView ?? []) {
      await execute(service, connectionByPlayerId.get(player.playerId)!, {
        id: `view-desc-${player.playerId}`,
        type: "game.submitDescription",
        payload: { text: "身份预览测试描述" },
      });
    }
    await execute(service, joined[3].connection, {
      id: "view-to-voting",
      type: "game.advancePhase",
      payload: {},
    });
    await execute(service, host, {
      id: "view-submit-vote",
      type: "game.submitVote",
      payload: { targetId: joined[0].joinResult.playerId },
    });

    const spectatorVotingState = getLastEventPayload<WhoIsFakerPrivateState>(
      spectator.connection,
      "game.privateState"
    );
    expect(spectatorVotingState?.privilegedActionPreview?.votes).toContainEqual({
      voterId: hostResult.playerId,
      targetId: joined[0].joinResult.playerId,
    });
    expect(
      getLastEventPayload<WhoIsFakerPrivateState>(host, "game.privateState")
        ?.privilegedActionPreview
    ).toBeUndefined();
  });

  test("天使只会看到无标签候选词，不会直接知道自己的身份词", async () => {
    const { service } = createTestContext();
    const { host } = await createRoom(service, "5959");
    const joined: JoinedPlayer[] = [];

    for (let index = 0; index < 10; index += 1) {
      const connection = createConnection(service, `angel-join-${index}`);
      const joinResult = (await execute(service, connection, {
        id: `angel-join-${index}`,
        type: "room.join",
        roomId: "5959",
        payload: {
          userName: `天使测试${index + 2}`,
        },
      })) as { playerId: string };
      joined.push({ connection, joinResult });
    }

    await execute(service, host, {
      id: "settings",
      type: "room.updateSettings",
      payload: {
        roleConfig: {
          undercoverCount: 1,
          hasAngel: true,
          hasBlank: false,
        },
      },
    });

    for (const connection of [host, ...joined.map((item) => item.connection)]) {
      await execute(service, connection, {
        id: `ready-${connection.record.id}`,
        type: "player.setReady",
        payload: { ready: true },
      });
    }

    await execute(service, host, { id: "start", type: "game.advancePhase", payload: {} });
    const questioner = joined[9];
    await execute(service, host, {
      id: "assign",
      type: "game.assignQuestioner",
      payload: { playerId: questioner.joinResult.playerId },
    });
    await execute(service, questioner.connection, {
      id: "words",
      type: "game.submitWords",
      payload: { words: ["苹果", "香蕉"] },
    });

    const angelConnection = [host, ...joined.map((item) => item.connection)].find((connection) => {
      const privateState = getLastEventPayload<WhoIsFakerPrivateState>(
        connection,
        "game.privateState"
      );
      return privateState?.role === "angel";
    });
    const angelPrivateState = angelConnection
      ? getLastEventPayload<WhoIsFakerPrivateState>(angelConnection, "game.privateState")
      : undefined;

    expect(angelPrivateState?.angelWordOptions).toEqual(["苹果", "香蕉"]);
    expect(angelPrivateState?.word).toBeUndefined();
  });

  test("游戏进行中可以转移房主并踢出普通玩家", async () => {
    const { service } = createTestContext();
    const { host, result: hostResult } = await createRoom(service, "Oblivionis");
    const extra = createConnection(service, "Oblivionis-review-extra");
    const extraJoin = (await execute(service, extra, {
      id: "extra-join",
      type: "room.join",
      roomId: "Oblivionis",
      payload: { userName: "复查玩家" },
    })) as { playerId: string };

    // 测试房间与真实房间同规则：4 名参战 + 1 名出题人，用机器人补足。
    await execute(service, host, {
      id: "add-bots",
      type: "test.addBot",
      payload: { count: 3 },
    });

    await execute(service, host, {
      id: "jump-voting",
      type: "test.jumpToPhase",
      payload: { phase: "voting" },
    });

    await execute(service, host, {
      id: "transfer-host-active",
      type: "room.transferHost",
      payload: { playerId: extraJoin.playerId },
    });

    let snapshot = getLastEventPayload<WhoIsFakerRoomSnapshot>(extra, "room.snapshot");
    expect(snapshot?.hostPlayerId).toBe(extraJoin.playerId);

    await execute(service, extra, {
      id: "kick-active",
      type: "room.kick",
      payload: { playerId: hostResult.playerId },
    });

    snapshot = getLastEventPayload<WhoIsFakerRoomSnapshot>(extra, "room.snapshot");
    expect(snapshot?.players.find((player) => player.id === hostResult.playerId)?.membership).toBe(
      "kicked"
    );
  });

  test("房主断线满 60 秒后转移给最早在线的正式玩家", async () => {
    const { service, advanceTime } = createTestContext();
    const { host, result: hostResult } = await createRoom(service, "2121");
    const spectator = createConnection(service, "2121-spectator");
    const spectatorJoin = (await execute(service, spectator, {
      id: "spectator-join",
      type: "room.join",
      roomId: "2121",
      payload: { userName: "旁观者" },
    })) as { playerId: string };
    await execute(service, spectator, {
      id: "become-spectator",
      type: "player.setSpectator",
      payload: { spectator: true },
    });

    advanceTime(1);
    const player = createConnection(service, "2121-player");
    const playerJoin = (await execute(service, player, {
      id: "player-join",
      type: "room.join",
      roomId: "2121",
      payload: { userName: "正式玩家" },
    })) as { playerId: string };

    await service.unregisterConnection(host.record.id);
    advanceTime(60 * 1000 - 1);
    await service.runHousekeeping();
    expect(getLastEventPayload<WhoIsFakerRoomSnapshot>(player, "room.snapshot")?.hostPlayerId).toBe(
      hostResult.playerId
    );

    advanceTime(1);
    await service.runHousekeeping();
    const snapshot = getLastEventPayload<WhoIsFakerRoomSnapshot>(player, "room.snapshot");
    expect(snapshot?.hostPlayerId).toBe(playerJoin.playerId);
    expect(snapshot?.hostPlayerId).not.toBe(spectatorJoin.playerId);
  });

  test("房主在宽限期内凭令牌重连会取消自动转移", async () => {
    const { service, advanceTime } = createTestContext();
    const { host, result } = await createRoom(service, "2323");
    const player = createConnection(service, "2323-player");
    await execute(service, player, {
      id: "player-join",
      type: "room.join",
      roomId: "2323",
      payload: { userName: "候选房主" },
    });

    await service.unregisterConnection(host.record.id);
    advanceTime(60 * 1000 - 1);
    const reconnectedHost = createConnection(service, "2323-reconnected-host");
    await execute(service, reconnectedHost, {
      id: "host-reconnect",
      type: "room.reconnect",
      payload: {
        roomId: "2323",
        sessionToken: result.sessionToken,
      },
    });

    advanceTime(1);
    await service.runHousekeeping();
    expect(
      getLastEventPayload<WhoIsFakerRoomSnapshot>(reconnectedHost, "room.snapshot")?.hostPlayerId
    ).toBe(result.playerId);
  });

  test("宽限期到达时没有正式玩家会在其加入后继续转移", async () => {
    const { service, advanceTime } = createTestContext();
    const { host } = await createRoom(service, "2525");
    const spectator = createConnection(service, "2525-spectator");
    await execute(service, spectator, {
      id: "spectator-join",
      type: "room.join",
      roomId: "2525",
      payload: { userName: "旁观者" },
    });
    await execute(service, spectator, {
      id: "become-spectator",
      type: "player.setSpectator",
      payload: { spectator: true },
    });

    await service.unregisterConnection(host.record.id);
    advanceTime(60 * 1000);
    await service.runHousekeeping();

    const player = createConnection(service, "2525-player");
    const playerJoin = (await execute(service, player, {
      id: "player-join",
      type: "room.join",
      roomId: "2525",
      payload: { userName: "后来玩家" },
    })) as { playerId: string };
    await service.runHousekeeping();

    expect(getLastEventPayload<WhoIsFakerRoomSnapshot>(player, "room.snapshot")?.hostPlayerId).toBe(
      playerJoin.playerId
    );
  });

  test("房主显式离开时无需等待宽限期即可转移", async () => {
    const { service } = createTestContext();
    const { host } = await createRoom(service, "2424");
    const player = createConnection(service, "2424-player");
    const playerJoin = (await execute(service, player, {
      id: "player-join",
      type: "room.join",
      roomId: "2424",
      payload: { userName: "接任玩家" },
    })) as { playerId: string };

    await execute(service, host, {
      id: "host-leave",
      type: "room.leave",
      payload: {},
    });

    expect(getLastEventPayload<WhoIsFakerRoomSnapshot>(player, "room.snapshot")?.hostPlayerId).toBe(
      playerJoin.playerId
    );
  });

  test("正式房间转移房主后原房主踢掉新房主，房主交给剩下的人", async () => {
    const { service } = createTestContext();
    const { host, result: hostResult } = await createRoom(service, "2222");

    const second = createConnection(service, "2222-second");
    const secondJoin = (await execute(service, second, {
      id: "second-join",
      type: "room.join",
      roomId: "2222",
      payload: { userName: "二号" },
    })) as { playerId: string };

    const third = createConnection(service, "2222-third");
    const thirdJoin = (await execute(service, third, {
      id: "third-join",
      type: "room.join",
      roomId: "2222",
      payload: { userName: "三号" },
    })) as { playerId: string };

    // 房主交给二号，二号再把原房主踢掉；房主必须仍落在二号身上。
    await execute(service, host, {
      id: "transfer-to-second",
      type: "room.transferHost",
      payload: { playerId: secondJoin.playerId },
    });
    expect(getLastEventPayload<WhoIsFakerRoomSnapshot>(second, "room.snapshot")?.hostPlayerId).toBe(
      secondJoin.playerId
    );

    await execute(service, second, {
      id: "kick-old-host",
      type: "room.kick",
      payload: { playerId: hostResult.playerId },
    });
    expect(getLastEventPayload<WhoIsFakerRoomSnapshot>(second, "room.snapshot")?.hostPlayerId).toBe(
      secondJoin.playerId
    );

    // 二号自己离开后，房主交给仅剩的三号，不悬空在已离开的人身上。
    await execute(service, second, {
      id: "second-leave",
      type: "room.leave",
      payload: {},
    });

    const snapshot = getLastEventPayload<WhoIsFakerRoomSnapshot>(third, "room.snapshot");
    expect(snapshot?.hostPlayerId).toBe(thirdJoin.playerId);
  });

  test("游戏中踢出出题人会中止本局", async () => {
    const { service } = createTestContext();
    const { host } = await createRoom(service, "Oblivionis");
    const supportingPlayers = Array.from({ length: 3 }, (_, index) =>
      createConnection(service, `Oblivionis-support-${index}`)
    );
    const questioner = createConnection(service, "Oblivionis-questioner");
    const questionerJoin = (await execute(service, questioner, {
      id: "questioner-join",
      type: "room.join",
      roomId: "Oblivionis",
      payload: { userName: "出题人" },
    })) as { playerId: string };

    for (const [index, connection] of supportingPlayers.entries()) {
      await execute(service, connection, {
        id: `support-join-${index}`,
        type: "room.join",
        roomId: "Oblivionis",
        payload: { userName: `正式玩家${index + 2}` },
      });
    }

    for (const connection of [host, ...supportingPlayers, questioner]) {
      await execute(service, connection, {
        id: `ready-${connection.record.id}`,
        type: "player.setReady",
        payload: { ready: true },
      });
    }

    await execute(service, host, {
      id: "start-kick-questioner",
      type: "game.advancePhase",
      payload: {},
    });
    await execute(service, host, {
      id: "assign-kicked-questioner",
      type: "game.assignQuestioner",
      payload: { playerId: questionerJoin.playerId },
    });
    await execute(service, questioner, {
      id: "words-before-kick",
      type: "game.submitWords",
      payload: { words: ["苹果", "香蕉"] },
    });
    await execute(service, host, {
      id: "kick-questioner",
      type: "room.kick",
      payload: { playerId: questionerJoin.playerId },
    });

    const snapshot = getLastEventPayload<WhoIsFakerRoomSnapshot>(host, "room.snapshot");
    expect(snapshot?.status.phase).toBe("gameOver");
    expect(snapshot?.summary?.winner).toBe("aborted");
    // 对局小结只经状态通道发布：结算不再广播 game.roundSummary 事件。
    expect(getEventPayloads<unknown>(host, "game.roundSummary")).toHaveLength(0);
    expect(
      snapshot?.players.find((player) => player.id === questionerJoin.playerId)?.membership
    ).toBe("kicked");
  });
});
