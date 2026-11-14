import { MusicProvider } from "../../src/infrastructure/music/MusicProvider";
import { describe, expect, test } from "bun:test";
import {
  connection,
  createRoom,
  execute,
  joinRoom,
  lastEvent,
  provider,
  songs,
  startRound,
} from "./Fixtures";
import { SonGuessrService } from "../../src/application/SonGuessrService";
import { SPECTATOR_OFFLINE_GRACE_MS } from "../../src/config/Constants";
import { SonGuessrRoomSnapshot, type SonGuessrPrivateState } from "../../src/shared/Index";

describe("SonGuessrService", () => {
  test("中途加入者可以预约下轮席位，旁观真人也可以担任出题人", async () => {
    const service = new SonGuessrService({
      musicProvider: provider,
      random: { nextInt: () => 0 },
    });
    const host = connection(service, "host");
    const guest = connection(service, "guest");
    const lateJoiner = connection(service, "late");
    const observer = connection(service, "observer");
    await createRoom(service, host);
    const hostState = lastEvent<SonGuessrPrivateState>(host, "song.game.privateState");
    await joinRoom(service, guest, "玩家");
    await startRound(service, host, guest, hostState.playerId);

    const lateState = await joinRoom(service, lateJoiner, "中途加入");
    expect(lastEvent<SonGuessrRoomSnapshot>(lateJoiner, "song.room.snapshot").players).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: lateState.playerId, membership: "spectator" }),
      ])
    );
    await expect(
      execute(service, lateJoiner, {
        id: "join-next-round",
        type: "song.player.setSpectator",
        roomId: "1234",
        payload: { spectator: false },
      })
    ).resolves.toEqual({ spectator: false, queued: true });
    expect(lastEvent<SonGuessrRoomSnapshot>(lateJoiner, "song.room.snapshot").players).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: lateState.playerId,
          membership: "spectator",
          nextRoundMembership: "active",
        }),
      ])
    );
    expect(lastEvent<SonGuessrPrivateState>(lateJoiner, "song.game.privateState").canGuess).toBe(
      false
    );
    const observerState = await joinRoom(service, observer, "旁观出题人");

    await execute(service, guest, {
      id: "give-up-first-round",
      type: "song.game.giveUp",
      roomId: "1234",
      payload: {},
    });
    await execute(service, host, {
      id: "next-round",
      type: "song.game.nextRound",
      roomId: "1234",
      payload: {},
    });
    expect(lastEvent<SonGuessrRoomSnapshot>(host, "song.room.snapshot").players).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: lateState.playerId, membership: "active" }),
      ])
    );
    await execute(service, host, {
      id: "choose-observer",
      type: "song.game.chooseSubmitter",
      roomId: "1234",
      payload: { playerId: observerState.playerId },
    });
    expect(lastEvent<SonGuessrPrivateState>(observer, "song.game.privateState").canSubmitSong).toBe(
      true
    );
    await execute(service, observer, {
      id: "observer-submits",
      type: "song.game.submitSong",
      roomId: "1234",
      payload: { songId: "answer" },
    });
    expect(lastEvent<SonGuessrRoomSnapshot>(host, "song.room.snapshot").currentRound).toMatchObject(
      { submitterPlayerId: observerState.playerId }
    );
    expect(lastEvent<SonGuessrPrivateState>(lateJoiner, "song.game.privateState").canGiveUp).toBe(
      true
    );
  });

  test("0 分旁观者掉线留够一次刷新的时间，超过宽限才移出", async () => {
    let clock = 1_000_000;
    const service = new SonGuessrService({
      musicProvider: provider,
      random: { nextInt: () => 0 },
      now: () => clock,
    });
    const host = connection(service, "spec-host");
    const spectator = connection(service, "spec-spectator");
    await createRoom(service, host);
    const specState = await joinRoom(service, spectator, "旁观者");
    await execute(service, spectator, {
      id: "set-spectator",
      type: "song.player.setSpectator",
      roomId: "1234",
      payload: { spectator: true },
    });
    const room = (service as any).rooms.get("1234")!;
    expect(room.players[specState.playerId]).toBeDefined();

    // 刷新：连接断开后席位还在，新连接凭原票据回到旁观席。
    await service.unregisterConnection(spectator.record.id);
    expect(room.players[specState.playerId]).toMatchObject({
      online: false,
      membership: "spectator",
    });
    const refreshed = connection(service, "spec-refreshed");
    await execute(service, refreshed, {
      id: "reconnect-spectator",
      type: "song.room.reconnect",
      payload: { roomId: "1234", sessionToken: specState.sessionToken },
    });
    expect(room.players[specState.playerId]).toMatchObject({
      online: true,
      membership: "spectator",
    });

    // 真走了：宽限内仍保留，超过才移出，且不等普通玩家那么久。
    await service.unregisterConnection(refreshed.record.id);
    clock += SPECTATOR_OFFLINE_GRACE_MS - 1;
    await service.runHousekeeping();
    expect(room.players[specState.playerId]).toBeDefined();
    clock += 1;
    await service.runHousekeeping();
    expect(room.players[specState.playerId]).toBeUndefined();
  });

  test("离线旁观者的下轮参战预约不会阻塞回合", async () => {
    const service = new SonGuessrService({ musicProvider: provider, random: { nextInt: () => 0 } });
    const host = connection(service, "offline-queue-host");
    const guest = connection(service, "offline-queue-guest");
    const lateJoiner = connection(service, "offline-queue-late");
    await createRoom(service, host);
    const hostState = lastEvent<SonGuessrPrivateState>(host, "song.game.privateState");
    await joinRoom(service, guest, "玩家");
    await startRound(service, host, guest, hostState.playerId);
    const lateState = await joinRoom(service, lateJoiner, "离线预约者");
    // 给该旁观者设置分数，确保不会作为0分旁观者在掉线时被立即移除
    (service as any).rooms.get("1234")!.players[lateState.playerId]!.score = 5;
    await execute(service, lateJoiner, {
      id: "queue-active-while-playing",
      type: "song.player.setSpectator",
      roomId: "1234",
      payload: { spectator: false },
    });
    await service.unregisterConnection(lateJoiner.record.id);
    await execute(service, guest, {
      id: "finish-first-round",
      type: "song.game.giveUp",
      roomId: "1234",
      payload: {},
    });
    await execute(service, host, {
      id: "prepare-next-round",
      type: "song.game.nextRound",
      roomId: "1234",
      payload: {},
    });
    await execute(service, host, {
      id: "choose-next-submitter",
      type: "song.game.chooseSubmitter",
      roomId: "1234",
      payload: { playerId: hostState.playerId },
    });
    await execute(service, host, {
      id: "submit-next-song",
      type: "song.game.submitSong",
      roomId: "1234",
      payload: { songId: "answer" },
    });

    const nextRound = lastEvent<SonGuessrRoomSnapshot>(host, "song.room.snapshot");
    expect(nextRound.phase).toBe("playing");
    expect(nextRound.players).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: lateState.playerId,
          membership: "spectator",
          nextRoundMembership: "active",
          online: false,
        }),
      ])
    );
    await execute(service, guest, {
      id: "finish-next-round",
      type: "song.game.giveUp",
      roomId: "1234",
      payload: {},
    });
    expect(lastEvent<SonGuessrRoomSnapshot>(host, "song.room.snapshot").phase).toBe("roundResult");
  });

  test("手动模式全员预约旁观后回到等待阶段且不创建空回合", async () => {
    const service = new SonGuessrService({ musicProvider: provider, random: { nextInt: () => 0 } });
    const host = connection(service, "all-watch-host");
    const guest = connection(service, "all-watch-guest");
    await createRoom(service, host);
    const hostState = lastEvent<SonGuessrPrivateState>(host, "song.game.privateState");
    const guestState = await joinRoom(service, guest, "玩家");
    await startRound(service, host, guest, hostState.playerId);
    for (const client of [host, guest]) {
      await execute(service, client, {
        id: `queue-watch-${client.record.id}`,
        type: "song.player.setSpectator",
        roomId: "1234",
        payload: { spectator: true },
      });
    }
    await execute(service, guest, {
      id: "finish-before-all-watch",
      type: "song.game.giveUp",
      roomId: "1234",
      payload: {},
    });
    await execute(service, host, {
      id: "next-after-all-watch",
      type: "song.game.nextRound",
      roomId: "1234",
      payload: {},
    });

    const snapshot = lastEvent<SonGuessrRoomSnapshot>(host, "song.room.snapshot");
    expect(snapshot.phase).toBe("waiting");
    expect(snapshot.currentRound).toBeUndefined();
    expect(snapshot.hostPlayerId).toBe(hostState.playerId);
    expect(snapshot.players).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: hostState.playerId, membership: "spectator", isHost: true }),
        expect.objectContaining({ id: guestState.playerId, membership: "spectator" }),
      ])
    );
  });

  test("自动模式全员预约旁观后回到等待阶段且不请求下一首歌", async () => {
    let songLoads = 0;
    const autoProvider: MusicProvider = {
      ...provider,
      getPlaylistSongs: async () => ({
        info: { id: "42", name: "自动题库", songCount: 1 },
        songs: [songs.answer],
      }),
      getSong: async (id) => {
        songLoads += 1;
        return provider.getSong(id);
      },
    };
    const service = new SonGuessrService({
      musicProvider: autoProvider,
      random: { nextInt: () => 0 },
    });
    const host = connection(service, "auto-all-watch-host");
    const guest = connection(service, "auto-all-watch-guest");
    await createRoom(service, host);
    await joinRoom(service, guest, "玩家");
    await execute(service, host, {
      id: "auto-all-watch-settings",
      type: "song.room.updateSettings",
      roomId: "1234",
      payload: {
        questionMode: "automatic",
        autoFilters: {
          playlist: { id: "42", name: "自动题库", songCount: 1 },
          artists: [],
          minPopularity: 0,
        },
      },
    });
    await execute(service, guest, {
      id: "auto-all-watch-ready",
      type: "song.player.setReady",
      roomId: "1234",
      payload: { ready: true },
    });
    await execute(service, host, {
      id: "auto-all-watch-start",
      type: "song.game.start",
      roomId: "1234",
      payload: {},
    });
    expect(songLoads).toBe(1);

    for (const client of [host, guest]) {
      await execute(service, client, {
        id: `auto-queue-watch-${client.record.id}`,
        type: "song.player.setSpectator",
        roomId: "1234",
        payload: { spectator: true },
      });
    }
    await execute(service, host, {
      id: "auto-finish-round",
      type: "song.game.giveUp",
      roomId: "1234",
      payload: {},
    });
    await execute(service, guest, {
      id: "auto-finish-round-guest",
      type: "song.game.giveUp",
      roomId: "1234",
      payload: {},
    });
    await execute(service, host, {
      id: "auto-next-after-all-watch",
      type: "song.game.nextRound",
      roomId: "1234",
      payload: {},
    });

    const snapshot = lastEvent<SonGuessrRoomSnapshot>(host, "song.room.snapshot");
    expect(snapshot.phase).toBe("waiting");
    expect(snapshot.currentRound).toBeUndefined();
    expect(songLoads).toBe(1);
  });

  test("手动模式开启自动轮流后直接轮到下一位正式玩家出题", async () => {
    const service = new SonGuessrService({ musicProvider: provider, random: { nextInt: () => 0 } });
    const host = connection(service, "rotate-host");
    const guest = connection(service, "rotate-guest");
    await createRoom(service, host);
    const hostState = lastEvent<SonGuessrPrivateState>(host, "song.game.privateState");
    const guestState = await joinRoom(service, guest, "轮流玩家");
    await execute(service, host, {
      id: "rotate-settings",
      type: "song.room.updateSettings",
      roomId: "1234",
      payload: { autoRotateSubmitter: true },
    });
    await startRound(service, host, guest, hostState.playerId);
    await execute(service, guest, {
      id: "rotate-give-up",
      type: "song.game.giveUp",
      roomId: "1234",
      payload: {},
    });
    await execute(service, host, {
      id: "rotate-next",
      type: "song.game.nextRound",
      roomId: "1234",
      payload: {},
    });
    expect(lastEvent<SonGuessrRoomSnapshot>(host, "song.room.snapshot")).toMatchObject({
      phase: "submittingSong",
      pendingSubmitterPlayerId: guestState.playerId,
    });
    expect(lastEvent<SonGuessrPrivateState>(guest, "song.game.privateState").canSubmitSong).toBe(
      true
    );
  });

  test("房主局中预约旁观在回合结束后依然保持房主身份", async () => {
    const service = new SonGuessrService({ musicProvider: provider, random: { nextInt: () => 0 } });
    const host = connection(service, "host-spec-test");
    const guest1 = connection(service, "guest1-spec-test");
    const guest2 = connection(service, "guest2-spec-test");
    await createRoom(service, host);
    const hostState = lastEvent<SonGuessrPrivateState>(host, "song.game.privateState");
    await joinRoom(service, guest1, "玩家1");
    await joinRoom(service, guest2, "玩家2");
    await execute(service, guest1, {
      id: "ready-1",
      type: "song.player.setReady",
      roomId: "1234",
      payload: { ready: true },
    });
    await execute(service, guest2, {
      id: "ready-2",
      type: "song.player.setReady",
      roomId: "1234",
      payload: { ready: true },
    });

    await execute(service, host, {
      id: "start",
      type: "song.game.start",
      roomId: "1234",
      payload: {},
    });
    await execute(service, host, {
      id: "choose",
      type: "song.game.chooseSubmitter",
      roomId: "1234",
      payload: { playerId: hostState.playerId },
    });
    await execute(service, host, {
      id: "song",
      type: "song.game.submitSong",
      roomId: "1234",
      payload: { songId: "answer" },
    });

    // 房主局中预约下轮旁观
    await execute(service, host, {
      id: "host-queue-spectator",
      type: "song.player.setSpectator",
      roomId: "1234",
      payload: { spectator: true },
    });

    const queuedSnapshot = lastEvent<SonGuessrRoomSnapshot>(host, "song.room.snapshot");
    const hostPlayerBefore = queuedSnapshot.players.find((p) => p.id === hostState.playerId);
    expect(hostPlayerBefore?.nextRoundMembership).toBe("spectator");
    expect(hostPlayerBefore?.isHost).toBe(true);

    // 玩家放弃回合，结算并进入下一轮准备阶段
    await execute(service, guest1, {
      id: "give-up-1",
      type: "song.game.giveUp",
      roomId: "1234",
      payload: {},
    });
    await execute(service, guest2, {
      id: "give-up-2",
      type: "song.game.giveUp",
      roomId: "1234",
      payload: {},
    });

    await execute(service, host, {
      id: "next-round",
      type: "song.game.nextRound",
      roomId: "1234",
      payload: {},
    });

    const nextSnapshot = lastEvent<SonGuessrRoomSnapshot>(host, "song.room.snapshot");
    const hostPlayerAfter = nextSnapshot.players.find((p) => p.id === hostState.playerId);
    expect(hostPlayerAfter?.membership).toBe("spectator");
    expect(hostPlayerAfter?.isHost).toBe(true);
    expect(nextSnapshot.hostPlayerId).toBe(hostState.playerId);
  });

  test("局中点击下轮加入旁观或玩家再次点击可撤销预约", async () => {
    const service = new SonGuessrService({ musicProvider: provider, random: { nextInt: () => 0 } });
    const host = connection(service, "toggle-host");
    const guest = connection(service, "toggle-guest");
    await createRoom(service, host);
    const hostState = lastEvent<SonGuessrPrivateState>(host, "song.game.privateState");
    const guestState = await joinRoom(service, guest, "玩家");
    await startRound(service, host, guest, hostState.playerId);

    // 玩家第一次点击下轮加入旁观：预约成功
    await execute(service, guest, {
      id: "queue-spec",
      type: "song.player.setSpectator",
      roomId: "1234",
      payload: { spectator: true },
    });
    let snapshot = lastEvent<SonGuessrRoomSnapshot>(guest, "song.room.snapshot");
    expect(snapshot.players.find((p) => p.id === guestState.playerId)?.nextRoundMembership).toBe(
      "spectator"
    );

    // 玩家第二次点击下轮加入旁观：撤销预约
    await execute(service, guest, {
      id: "cancel-queue-spec",
      type: "song.player.setSpectator",
      roomId: "1234",
      payload: { spectator: true },
    });
    snapshot = lastEvent<SonGuessrRoomSnapshot>(guest, "song.room.snapshot");
    expect(
      snapshot.players.find((p) => p.id === guestState.playerId)?.nextRoundMembership
    ).toBeUndefined();
  });

  test("「下轮加入」的席位只在再来一轮时生效，选人出题都不算换轮", async () => {
    const service = new SonGuessrService({ musicProvider: provider, random: { nextInt: () => 0 } });
    const host = connection(service, "seat-host");
    const guest = connection(service, "seat-guest");
    const other = connection(service, "seat-other");
    await createRoom(service, host);
    const hostState = lastEvent<SonGuessrPrivateState>(host, "song.game.privateState");
    const guestState = await joinRoom(service, guest, "预约旁观的玩家");
    await joinRoom(service, other, "另一位玩家");
    for (const client of [guest, other]) {
      await execute(service, client, {
        id: `ready-${client.record.id}`,
        type: "song.player.setReady",
        roomId: "1234",
        payload: { ready: true },
      });
    }
    const seat = (playerId: string) =>
      lastEvent<SonGuessrRoomSnapshot>(host, "song.room.snapshot").players.find(
        (player) => player.id === playerId
      );

    await execute(service, host, {
      id: "seat-start",
      type: "song.game.start",
      roomId: "1234",
      payload: {},
    });
    await execute(service, host, {
      id: "seat-choose",
      type: "song.game.chooseSubmitter",
      roomId: "1234",
      payload: { playerId: hostState.playerId },
    });
    await execute(service, host, {
      id: "seat-submit",
      type: "song.game.submitSong",
      roomId: "1234",
      payload: { songId: "answer" },
    });
    expect(lastEvent<SonGuessrRoomSnapshot>(host, "song.room.snapshot").phase).toBe("playing");

    // 局中预约：只在下一个轮次起点生效
    await execute(service, guest, {
      id: "seat-queue-spectator",
      type: "song.player.setSpectator",
      roomId: "1234",
      payload: { spectator: true },
    });
    await execute(service, guest, {
      id: "seat-give-up-1",
      type: "song.game.giveUp",
      roomId: "1234",
      payload: {},
    });
    await execute(service, other, {
      id: "seat-give-up-2",
      type: "song.game.giveUp",
      roomId: "1234",
      payload: {},
    });
    expect(seat(guestState.playerId)).toMatchObject({
      membership: "active",
      nextRoundMembership: "spectator",
    });

    // 点了再来一轮、进入选出题人，这一刻已经是下一轮
    await execute(service, host, {
      id: "seat-next-1",
      type: "song.game.nextRound",
      roomId: "1234",
      payload: {},
    });
    const switched = lastEvent<SonGuessrRoomSnapshot>(host, "song.room.snapshot");
    expect(switched.phase).toBe("choosingSubmitter");
    expect(seat(guestState.playerId)).toMatchObject({
      membership: "spectator",
      nextRoundMembership: undefined,
    });

    // 选出题人阶段再预约回来：本局选定出题人和提交题目都不能生效
    await execute(service, guest, {
      id: "seat-queue-active",
      type: "song.player.setSpectator",
      roomId: "1234",
      payload: { spectator: false },
    });
    await execute(service, host, {
      id: "seat-choose-2",
      type: "song.game.chooseSubmitter",
      roomId: "1234",
      payload: { playerId: hostState.playerId },
    });
    await execute(service, host, {
      id: "seat-submit-2",
      type: "song.game.submitSong",
      roomId: "1234",
      payload: { songId: "answer" },
    });
    expect(lastEvent<SonGuessrRoomSnapshot>(host, "song.room.snapshot").phase).toBe("playing");
    expect(seat(guestState.playerId)).toMatchObject({
      membership: "spectator",
      nextRoundMembership: "active",
    });

    await execute(service, other, {
      id: "seat-give-up-3",
      type: "song.game.giveUp",
      roomId: "1234",
      payload: {},
    });
    await execute(service, host, {
      id: "seat-next-2",
      type: "song.game.nextRound",
      roomId: "1234",
      payload: {},
    });
    expect(seat(guestState.playerId)).toMatchObject({
      membership: "active",
      nextRoundMembership: undefined,
    });
  });
});
