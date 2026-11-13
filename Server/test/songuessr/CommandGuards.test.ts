import { describe, expect, test } from "bun:test";

import { SonGuessrService } from "../../src/application/SonGuessrService";
import type { SonGuessrClientMessage } from "../../src/shared/Index";
import { TEST_ROOMS_ON } from "../TestRoomPolicy";
import { anime, connection, createRoom, execute, joinRoom, provider, startRound } from "./Fixtures";
import type { TestConnection } from "./Fixtures";

/**
 * 命令守卫的先后顺序：同时违反两条规则的请求拿到哪个错误码，由守卫顺序决定。
 * 这里只断言对外可见的错误码与文案，不碰实现；命令分发怎么组织都不能改变它们。
 */

type Failure = { code: string; message: string };

const setup = async () => {
  const service = new SonGuessrService({ musicProvider: provider, testRooms: TEST_ROOMS_ON });
  const host = connection(service, "host");
  const guest = connection(service, "guest");
  await createRoom(service, host);
  await joinRoom(service, guest, "访客");
  const room = service.rooms.get("1234")!;
  const idOf = (name: string) => Object.values(room.players).find((p) => p.name === name)!.id;
  const seatOf = (name: string) => Object.values(room.players).find((p) => p.name === name)!;
  const rejected = async (
    who: TestConnection,
    type: string,
    payload: Record<string, unknown> = {},
    roomId = "1234"
  ): Promise<Failure> => {
    try {
      await execute(service, who, { id: "g", type, roomId, payload } as SonGuessrClientMessage);
    } catch (error) {
      return error as Failure;
    }
    throw new Error(`${type} 应被拒绝`);
  };
  return { service, host, guest, room, idOf, seatOf, rejected };
};

describe("命令守卫顺序：身份先于一切守卫", () => {
  test("未入房的连接发任何座位命令都先得到未入房", async () => {
    const { service, rejected } = await setup();
    const outsider = connection(service, "outsider");
    const commands: Array<[string, Record<string, unknown>]> = [
      ["song.room.updateSettings", {}],
      ["song.game.start", {}],
      ["song.room.kick", { playerId: "x" }],
      ["song.test.addBot", {}],
      ["song.player.setReady", { ready: true }],
      ["song.chat.send", { text: "" }],
      ["song.music.search", { keyword: "a" }],
      ["song.game.guess", { songId: "a" }],
    ];
    for (const [type, payload] of commands) {
      expect(await rejected(outsider, type, payload)).toMatchObject({
        code: "PLAYER_NOT_IN_ROOM",
        message: "当前连接尚未加入房间",
      });
    }
  });

  test("房间已不存在时先得到房间不存在", async () => {
    const { service, host, rejected } = await setup();
    service.rooms.delete("1234");
    expect(await rejected(host, "song.game.start")).toMatchObject({
      code: "ROOM_NOT_FOUND",
      message: "房间不存在",
    });
  });
});

describe("命令守卫顺序：房主先于阶段与目标", () => {
  test("非房主在任何阶段都先被拒为 FORBIDDEN", async () => {
    const { guest, room, rejected } = await setup();
    const commands: Array<[string, Record<string, unknown>]> = [
      ["song.room.updateSettings", {}],
      ["song.game.start", {}],
      ["song.game.chooseSubmitter", { playerId: "nobody" }],
      ["song.game.skipRound", {}],
      ["song.game.nextRound", {}],
      ["song.game.finish", {}],
      ["song.room.kick", { playerId: "nobody" }],
      ["song.room.transferHost", { playerId: "nobody" }],
      ["song.test.addBot", {}],
      ["song.test.removeBot", {}],
    ];
    for (const phase of ["waiting", "playing", "roundResult"] as const) {
      room.phase = phase;
      for (const [type, payload] of commands) {
        expect(await rejected(guest, type, payload)).toMatchObject({
          code: "FORBIDDEN",
          message: "只有房主可以执行该操作",
        });
      }
    }
  });

  test("房主在错误阶段拿到各命令自己的阶段错误", async () => {
    const { host, room, rejected } = await setup();
    room.phase = "waiting";
    expect(await rejected(host, "song.game.chooseSubmitter", { playerId: "x" })).toMatchObject({
      code: "INVALID_PHASE",
      message: "当前不能选择出题人",
    });
    expect(await rejected(host, "song.game.skipRound")).toMatchObject({
      code: "NO_ACTIVE_ROUND",
    });
    expect(await rejected(host, "song.game.nextRound")).toMatchObject({
      code: "INVALID_PHASE",
      message: "当前不在回合结算阶段",
    });
    expect(await rejected(host, "song.game.finish")).toMatchObject({
      code: "INVALID_PHASE",
      message: "只能在回合结算后返回等待阶段",
    });
    room.phase = "playing";
    expect(await rejected(host, "song.room.updateSettings", {})).toMatchObject({
      code: "INVALID_PHASE",
      message: "只能在等待阶段修改房间设置",
    });
    expect(await rejected(host, "song.game.start")).toMatchObject({
      code: "INVALID_PHASE",
      message: "当前不能开始新游戏",
    });
  });

  test("房主在正确阶段才会走到目标判定", async () => {
    const { host, idOf, rejected } = await setup();
    expect(await rejected(host, "song.room.kick", { playerId: idOf("房主") })).toMatchObject({
      code: "INVALID_TARGET",
    });
    expect(await rejected(host, "song.room.kick", { playerId: "nobody" })).toMatchObject({
      code: "PLAYER_NOT_FOUND",
      message: "玩家不存在",
    });
  });

  test("测试指令：非房主先 FORBIDDEN，房主在普通房才是 TEST_ROOM_ONLY", async () => {
    const { guest, host, rejected } = await setup();
    for (const type of ["song.test.addBot", "song.test.removeBot"]) {
      expect(await rejected(guest, type)).toMatchObject({ code: "FORBIDDEN" });
      expect(await rejected(host, type)).toMatchObject({
        code: "TEST_ROOM_ONLY",
        message: "该指令仅用于测试房间",
      });
    }
  });
});

describe("命令守卫顺序：开局中不可操作", () => {
  test("开局在途时设置与开局都被拒，且仍是房主先于开局中", async () => {
    for (const runtime of [{ automaticRoundLoading: true }, { manualRoundStarting: true }]) {
      const { host, guest, room, rejected } = await setup();
      room.runtime = { ...runtime };
      expect(await rejected(guest, "song.room.updateSettings", {})).toMatchObject({
        code: "FORBIDDEN",
      });
      expect(await rejected(guest, "song.game.start")).toMatchObject({ code: "FORBIDDEN" });
      expect(
        await rejected(host, "song.room.updateSettings", { questionType: "anime" })
      ).toMatchObject({ code: "INVALID_PHASE", message: "只能在等待阶段修改房间设置" });
      expect(await rejected(host, "song.game.start")).toMatchObject({
        code: "INVALID_PHASE",
        message: "当前不能开始新游戏",
      });
      expect(room.settings.questionType).toBe("song");
      // 开局中的判定排在口令与名称校验之前：缺口令的私密化请求也先拿到阶段错误。
      expect(
        await rejected(host, "song.room.updateSettings", { visibility: "private" })
      ).toMatchObject({ code: "INVALID_PHASE", message: "只能在等待阶段修改房间设置" });
    }
  });

  test("账号共享开关只认自动开局加载，口径与设置、开局不同", async () => {
    const { host, room, rejected, service } = await setup();
    room.runtime = { automaticRoundLoading: true };
    expect(
      await rejected(host, "song.auth.setPoolSharing", { platform: "netease", enabled: false })
    ).toMatchObject({ code: "INVALID_PHASE", message: "开局后不能再改账号共享开关" });
    room.runtime = { manualRoundStarting: true };
    const done = await execute(service, host, {
      id: "pool",
      type: "song.auth.setPoolSharing",
      roomId: "1234",
      payload: { platform: "netease", enabled: false },
    } as SonGuessrClientMessage);
    expect(done).toMatchObject({ enabled: false });
  });
});

describe("命令守卫顺序：座位命令的阶段与成员身份", () => {
  test("准备：阶段先于旁观者身份", async () => {
    const { guest, room, seatOf, rejected } = await setup();
    seatOf("访客").membership = "spectator";
    room.phase = "playing";
    expect(await rejected(guest, "song.player.setReady", { ready: true })).toMatchObject({
      code: "INVALID_PHASE",
      message: "只能在等待阶段准备",
    });
    room.phase = "waiting";
    expect(await rejected(guest, "song.player.setReady", { ready: true })).toMatchObject({
      code: "SPECTATOR_FORBIDDEN",
      message: "旁观者不能准备",
    });
  });

  test("选队：单人房先于阶段，阶段先于旁观者，旁观者先于队伍号", async () => {
    const { guest, room, seatOf, rejected, service } = await setup();
    const soloHost = connection(service, "solo-host");
    await createRoom(service, soloHost, { roomId: "5678", solo: true });
    service.rooms.get("5678")!.phase = "playing";
    expect(await rejected(soloHost, "song.player.setTeam", { team: 1 }, "5678")).toMatchObject({
      code: "SOLO_ROOM_FORBIDDEN",
      message: "单人房间没有队伍",
    });

    const guestSeat = seatOf("访客");
    guestSeat.membership = "spectator";
    room.phase = "playing";
    expect(await rejected(guest, "song.player.setTeam", { team: 99 })).toMatchObject({
      code: "INVALID_PHASE",
      message: "只能在等待阶段更换队伍",
    });
    room.phase = "waiting";
    expect(await rejected(guest, "song.player.setTeam", { team: 99 })).toMatchObject({
      code: "SPECTATOR_FORBIDDEN",
      message: "旁观者没有队伍",
    });
    guestSeat.membership = "active";
    expect(await rejected(guest, "song.player.setTeam", { team: 99 })).toMatchObject({
      code: "INVALID_TEAM",
    });
  });
});

describe("命令守卫顺序：出题命令", () => {
  test("提交歌曲：不是待出题人在任何阶段都报同一错误", async () => {
    const { guest, room, rejected } = await setup();
    for (const phase of ["waiting", "submittingSong"] as const) {
      room.phase = phase;
      expect(await rejected(guest, "song.game.submitSong", { songId: "answer" })).toMatchObject({
        code: "NOT_SUBMITTER",
        message: "只有当前出题人可以提交歌曲",
      });
    }
  });

  test("提交番剧：题型先于出题人，出题人先于接口是否配置", async () => {
    const { guest, room, idOf, rejected } = await setup();
    room.phase = "submittingSong";
    expect(await rejected(guest, "song.game.submitAnime", { subjectId: "1" })).toMatchObject({
      code: "INVALID_QUESTION_TYPE",
      message: "当前房间不是听歌猜番模式",
    });
    room.settings.questionType = "anime";
    expect(await rejected(guest, "song.game.submitAnime", { subjectId: "1" })).toMatchObject({
      code: "NOT_SUBMITTER",
      message: "只有当前出题人可以提交番剧",
    });
    room.pendingSubmitterPlayerId = idOf("访客");
    expect(await rejected(guest, "song.game.submitAnime", { subjectId: "1" })).toMatchObject({
      code: "BANGUMI_API_UNAVAILABLE",
    });
  });

  test("预览歌曲：出题人先于自选片段开关，开关先于音乐配额", async () => {
    const { guest, room, idOf, rejected } = await setup();
    room.phase = "submittingSong";
    room.settings.allowCustomClip = false;
    expect(await rejected(guest, "song.music.detail", { songId: "answer" })).toMatchObject({
      code: "NOT_SUBMITTER",
      message: "只有当前出题人可以预览歌曲",
    });
    room.pendingSubmitterPlayerId = idOf("访客");
    // 超过配额次数也一直是开关错误：被守卫拒绝的请求不消耗音乐配额。
    for (let index = 0; index < 25; index += 1) {
      expect(await rejected(guest, "song.music.detail", { songId: "answer" })).toMatchObject({
        code: "CUSTOM_CLIP_DISABLED",
      });
    }
  });
});

describe("命令守卫顺序：音乐配额的记账时机", () => {
  test("旁观者先被身份拒绝，不消耗配额", async () => {
    const { guest, seatOf, rejected } = await setup();
    seatOf("访客").membership = "spectator";
    for (let index = 0; index < 25; index += 1) {
      expect(await rejected(guest, "song.music.artist.search", { keyword: "a" })).toMatchObject({
        code: "SPECTATOR_FORBIDDEN",
        message: "旁观者不能进行音乐操作",
      });
    }
  });

  test("正式成员：配额先于歌单解析与能力判定", async () => {
    const { guest, host, rejected } = await setup();
    for (let index = 0; index < 20; index += 1) {
      expect(await rejected(guest, "song.music.playlist.resolve", { value: "%%%" })).toMatchObject({
        code: "INVALID_PLAYLIST",
      });
    }
    expect(await rejected(guest, "song.music.playlist.resolve", { value: "%%%" })).toMatchObject({
      code: "RATE_LIMITED",
      message: "音乐请求过于频繁，请稍后再试",
    });
    for (let index = 0; index < 20; index += 1) {
      expect(await rejected(host, "song.music.artist.search", { keyword: "a" })).toMatchObject({
        code: "MUSIC_API_UNAVAILABLE",
      });
    }
    expect(await rejected(host, "song.music.artist.search", { keyword: "a" })).toMatchObject({
      code: "RATE_LIMITED",
    });
  });

  test("番剧命令不过音乐门：旁观者也只会遇到接口未配置", async () => {
    const { guest, seatOf, rejected } = await setup();
    seatOf("访客").membership = "spectator";
    for (const type of ["song.bangumi.search", "song.bangumi.songs", "song.subject.image"]) {
      for (let index = 0; index < 25; index += 1) {
        expect(await rejected(guest, type, { keyword: "a", subjectId: "1" })).toMatchObject({
          code: "BANGUMI_API_UNAVAILABLE",
        });
      }
    }
  });

  test("放弃加载音频：陈旧通知被忽略且不记账，真正刷新才记账", async () => {
    const { service, host, guest, idOf, rejected } = await setup();
    await startRound(service, host, guest, idOf("房主"));
    // 出题人上报是被忽略的，不消耗配额，次数再多也不会限流。
    for (let index = 0; index < 25; index += 1) {
      const result = await execute(service, host, {
        id: "f",
        type: "song.game.audioFailed",
        roomId: "1234",
        payload: { roundNumber: 1 },
      } as SonGuessrClientMessage);
      expect(result).toEqual({ ignored: true });
    }
    for (let index = 0; index < 20; index += 1) {
      expect(await rejected(guest, "song.game.audioFailed", { roundNumber: 1 })).toMatchObject({
        code: "MUSIC_API_UNAVAILABLE",
      });
    }
    expect(await rejected(guest, "song.game.audioFailed", { roundNumber: 1 })).toMatchObject({
      code: "RATE_LIMITED",
    });
  });
});

describe("命令守卫顺序：猜测命令", () => {
  test("没有回合先得到无进行中回合", async () => {
    const { host, rejected } = await setup();
    for (const type of ["song.game.guess", "song.game.guessAnime", "song.game.giveUp"]) {
      expect(await rejected(host, type, { songId: "a", subjectId: "a" })).toMatchObject({
        code: "NO_ACTIVE_ROUND",
        message: "当前没有进行中的回合",
      });
    }
  });

  test("猜歌：题型先于旁观者；猜番：旁观者先于出题人，出题人先于音频就绪", async () => {
    const { service, host, guest, idOf, rejected } = await setup();
    await startRound(service, host, guest, idOf("房主"));
    const room = service.rooms.get("1234")!;
    const watcher = connection(service, "watcher");
    await joinRoom(service, watcher, "路人");
    expect(Object.values(room.players).find((p) => p.name === "路人")!.membership).toBe(
      "spectator"
    );

    expect(await rejected(watcher, "song.game.guess", { songId: "a" })).toMatchObject({
      code: "SPECTATOR_FORBIDDEN",
      message: "旁观者不能猜歌",
    });
    room.currentRound!.anime = anime;
    expect(await rejected(watcher, "song.game.guess", { songId: "a" })).toMatchObject({
      code: "INVALID_QUESTION_TYPE",
      message: "当前房间是听歌猜番模式",
    });
    room.currentRound!.anime = undefined;

    expect(await rejected(watcher, "song.game.guessAnime", { subjectId: "a" })).toMatchObject({
      code: "INVALID_QUESTION_TYPE",
      message: "当前房间不是听歌猜番模式",
    });
    room.settings.questionType = "anime";
    room.currentRound!.anime = anime;
    expect(await rejected(watcher, "song.game.guessAnime", { subjectId: "a" })).toMatchObject({
      code: "SPECTATOR_FORBIDDEN",
      message: "旁观者不能猜番",
    });
    expect(await rejected(host, "song.game.guessAnime", { subjectId: "a" })).toMatchObject({
      code: "SUBMITTER_CANNOT_GUESS",
      message: "出题人不能参与猜番",
    });
    expect(await rejected(guest, "song.game.guessAnime", { subjectId: "a" })).toMatchObject({
      code: "AUDIO_NOT_READY",
    });
  });
});
