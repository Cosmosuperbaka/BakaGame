import { HOST_RECONNECT_TIMEOUT_MS } from "../../src/config/Constants";
import { describe, expect, test } from "bun:test";
import { connection, createRoom, execute, joinRoom, lastEvent, provider } from "./Fixtures";
import { SonGuessrService } from "../../src/application/SonGuessrService";
import { TEST_ROOMS_ON } from "../TestRoomPolicy";
import { type SonGuessrPrivateState, type SonGuessrRoomSnapshot } from "../../src/shared/Index";

describe("SonGuessrService", () => {
  test("Oblivionis 测试房支持人机并不会进入大厅或被空房清理", async () => {
    let now = 1_000_000;
    const service = new SonGuessrService({
      testRooms: TEST_ROOMS_ON,
      musicProvider: provider,
      now: () => now,
    });
    const host = connection(service, "host");
    await createRoom(service, host, { roomId: "Oblivionis", name: "测试房" });

    await execute(service, host, {
      id: "add-bots",
      type: "song.test.addBot",
      roomId: "Oblivionis",
      payload: { count: 2 },
    });
    const withBots = lastEvent<SonGuessrRoomSnapshot>(host, "song.room.snapshot");
    expect(withBots.testMode).toBe(true);
    expect(withBots.players.filter((player) => player.isBot)).toHaveLength(2);
    expect(service.getRoomSummaries()).toHaveLength(0);

    await service.unregisterConnection(host.record.id);
    // 测试房的房主掉线同样有重连宽限：宽限过后新进来的人才会接任。
    now += HOST_RECONNECT_TIMEOUT_MS + 1;
    await service.runHousekeeping();
    const replacement = connection(service, "replacement");
    const replacementState = await joinRoom(service, replacement, "新房主", "Oblivionis");
    expect(lastEvent<SonGuessrRoomSnapshot>(replacement, "song.room.snapshot").hostPlayerId).toBe(
      replacementState.playerId
    );

    await execute(service, replacement, {
      id: "remove-bot",
      type: "song.test.removeBot",
      roomId: "Oblivionis",
      payload: { count: 1 },
    });
    expect(
      lastEvent<SonGuessrRoomSnapshot>(replacement, "song.room.snapshot").players.filter(
        (player) => player.isBot
      )
    ).toHaveLength(1);
  });

  test("Oblivionis 测试房刷新重连后保留房主权限", async () => {
    const service = new SonGuessrService({ testRooms: TEST_ROOMS_ON, musicProvider: provider });
    const host = connection(service, "host");
    await createRoom(service, host, { roomId: "Oblivionis", name: "测试房" });
    const hostState = lastEvent<SonGuessrPrivateState>(host, "song.game.privateState");
    await execute(service, host, {
      id: "add-bot-before-refresh",
      type: "song.test.addBot",
      roomId: "Oblivionis",
      payload: { count: 1 },
    });
    const botId = lastEvent<SonGuessrRoomSnapshot>(host, "song.room.snapshot").players.find(
      (player) => player.isBot
    )!.id;

    await service.unregisterConnection(host.record.id);
    const refreshed = connection(service, "host-refreshed");
    await execute(service, refreshed, {
      id: "reconnect-after-refresh",
      type: "song.room.reconnect",
      payload: { roomId: "Oblivionis", sessionToken: hostState.sessionToken },
    });

    expect(lastEvent<SonGuessrRoomSnapshot>(refreshed, "song.room.snapshot").hostPlayerId).toBe(
      hostState.playerId
    );
    await expect(
      execute(service, refreshed, {
        id: "kick-after-refresh",
        type: "song.room.kick",
        roomId: "Oblivionis",
        payload: { playerId: botId },
      })
    ).resolves.toEqual({ kicked: true });
  });

  test("Oblivionis 测试房允许出题人自己猜且提交歌曲不会被误判为猜对", async () => {
    const service = new SonGuessrService({
      testRooms: TEST_ROOMS_ON,
      musicProvider: provider,
      random: { nextInt: () => 0 },
    });
    const host = connection(service, "host");
    await createRoom(service, host, { roomId: "Oblivionis", name: "测试房" });
    const hostState = lastEvent<SonGuessrPrivateState>(host, "song.game.privateState");

    await execute(service, host, {
      id: "add-bot",
      type: "song.test.addBot",
      roomId: "Oblivionis",
      payload: { count: 1 },
    });
    await execute(service, host, {
      id: "start",
      type: "song.game.start",
      roomId: "Oblivionis",
      payload: {},
    });
    await execute(service, host, {
      id: "choose-self",
      type: "song.game.chooseSubmitter",
      roomId: "Oblivionis",
      payload: { playerId: hostState.playerId },
    });
    await execute(service, host, {
      id: "submit-answer",
      type: "song.game.submitSong",
      roomId: "Oblivionis",
      payload: { songId: "answer" },
    });

    expect(lastEvent<SonGuessrRoomSnapshot>(host, "song.room.snapshot").phase).toBe("playing");
    const playingAudioUrl = lastEvent<SonGuessrRoomSnapshot>(host, "song.room.snapshot")
      .currentRound?.audioUrl;
    expect(playingAudioUrl).toMatch(/\/api\/songuessr\/audio\/Oblivionis\//);
    expect(lastEvent<SonGuessrPrivateState>(host, "song.game.privateState")).toMatchObject({
      isSubmitter: true,
      canGuess: false,
      canGiveUp: true,
      visibleAttempts: [],
    });

    await execute(service, host, {
      id: "self-audio-ready",
      type: "song.game.audioReady",
      roomId: "Oblivionis",
      payload: { roundNumber: 1 },
    });
    expect(lastEvent<SonGuessrPrivateState>(host, "song.game.privateState").canGuess).toBe(true);

    const wrong = (await execute(service, host, {
      id: "self-wrong-guess",
      type: "song.game.guess",
      roomId: "Oblivionis",
      payload: { songId: "wrong" },
    })) as { attempt: { result: string } };
    expect(wrong.attempt.result).toBe("wrong");
    expect(lastEvent<SonGuessrRoomSnapshot>(host, "song.room.snapshot").phase).toBe("playing");

    const correct = (await execute(service, host, {
      id: "self-correct-guess",
      type: "song.game.guess",
      roomId: "Oblivionis",
      payload: { songId: "answer" },
    })) as { attempt: { result: string } };
    expect(correct.attempt.result).toBe("correct");
    const result = lastEvent<SonGuessrRoomSnapshot>(host, "song.room.snapshot");
    expect(result.phase).toBe("roundResult");
    expect(result.roundSummary?.correctPlayerIds).toContain(hostState.playerId);
    // 揭晓后继续用同一个站内地址，播放不中断；上游地址不下发。
    expect(result.roundSummary?.song.audioUrl).toBe(playingAudioUrl);
    expect(result.roundSummary?.song.chorus).toEqual({ startTime: 50_000, endTime: 90_000 });
  });
});
