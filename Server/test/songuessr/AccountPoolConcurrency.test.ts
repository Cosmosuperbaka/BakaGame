import { SonGuessrPrivateState, SonGuessrRoomSnapshot } from "../../src/shared/Index";
import { describe, expect, test } from "bun:test";
import { connection, createRoom, execute, joinRoom, lastEvent, provider, songs } from "./Fixtures";
import { SonGuessrService } from "../../src/application/SonGuessrService";
import {
  type MusicCookieInput,
  type MusicProvider,
} from "../../src/infrastructure/NeteaseMusicProvider";

describe("账号池单号并发", () => {
  const gatedProvider = (usedCookies: Array<MusicCookieInput | undefined>) => {
    const releases: Array<() => void> = [];
    const musicProvider: MusicProvider = {
      ...provider,
      search: async (_keyword, _limit, cookie) => {
        usedCookies.push(cookie);
        await new Promise<void>((resolve) => releases.push(resolve));
        return [songs.answer];
      },
    };
    return { musicProvider, releases };
  };

  const waitCalls = async (usedCookies: unknown[], count: number) => {
    for (let attempt = 0; attempt < 400 && usedCookies.length < count; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 1));
    }
    expect(usedCookies.length).toBe(count);
  };

  test("单号限额与改造前一致：3 个并发，第 4 个排队等空位", async () => {
    const usedCookies: Array<MusicCookieInput | undefined> = [];
    const { musicProvider, releases } = gatedProvider(usedCookies);
    const service = new SonGuessrService({ musicProvider });
    const host = connection(service, "single-account-host");
    await createRoom(service, host);

    const search = (id: string) =>
      execute(service, host, {
        id,
        type: "song.music.search",
        roomId: "1234",
        payload: { keyword: id },
      });
    const pending = [search("search-1")];
    await waitCalls(usedCookies, 1);
    // 单号上限取改造前 provider 的全局并发 3：前三个请求由这个号接单。
    for (let index = 2; index <= 4; index += 1) {
      pending.push(search(`search-${index}`));
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    expect(usedCookies).toHaveLength(3);

    // 第 4 个在排队而不是降级：归还一个租约后它拿到的还是这个号。
    releases.shift()!();
    await waitCalls(usedCookies, 4);
    expect(usedCookies).toEqual([
      { netease: "MUSIC_U=test-host" },
      { netease: "MUSIC_U=test-host" },
      { netease: "MUSIC_U=test-host" },
      { netease: "MUSIC_U=test-host" },
    ]);
    releases.splice(0).forEach((release) => release());
    await Promise.all(pending);
  });

  test("多号按单号限额倍乘：两个号最多 6 个在途，第 7 个排队", async () => {
    const usedCookies: Array<MusicCookieInput | undefined> = [];
    const { musicProvider, releases } = gatedProvider(usedCookies);
    const service = new SonGuessrService({ musicProvider });
    const host = connection(service, "two-account-host");
    const guest = connection(service, "two-account-guest");
    await createRoom(service, host);
    await joinRoom(service, guest, "贡献者");
    await execute(service, guest, {
      id: "guest-loads",
      type: "song.auth.useCookie",
      roomId: "1234",
      payload: { cookie: "MUSIC_U=guest-cookie" },
    });

    const search = (id: string) =>
      execute(service, host, {
        id,
        type: "song.music.search",
        roomId: "1234",
        payload: { keyword: id },
      });
    const pending = [search("multi-1")];
    await waitCalls(usedCookies, 1);
    for (let index = 2; index <= 7; index += 1) {
      pending.push(search(`multi-${index}`));
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    expect(usedCookies).toHaveLength(6);

    // 每个号各 3 个在途，总容量 = 3 × 2；第 7 个排队等空位，归还后继续用号而不是降级。
    releases.shift()!();
    await waitCalls(usedCookies, 7);
    expect(usedCookies).toHaveLength(7);
    expect(usedCookies.every(Boolean)).toBe(true);
    releases.splice(0).forEach((release) => release());
    await Promise.all(pending);
  });
});

test("Agent 默认被拒绝，房主打开 allowAgents 后可进入并带身份标记", async () => {
  const service = new SonGuessrService({ musicProvider: provider });
  const host = connection(service, "agent-admission-host");
  await createRoom(service, host);
  const agent = connection(service, "agent-admission");
  agent.record.isAgent = true;

  await expect(
    execute(service, agent, {
      id: "agent-join-denied",
      type: "song.room.join",
      roomId: "1234",
      payload: { userName: "AgentOne" },
    })
  ).rejects.toMatchObject({ code: "AGENTS_NOT_ALLOWED" });

  await execute(service, host, {
    id: "allow-agents",
    type: "song.room.updateSettings",
    roomId: "1234",
    payload: { allowAgents: true },
  });
  const joined = await execute<{ playerId: string; snapshot: SonGuessrRoomSnapshot }>(
    service,
    agent,
    {
      id: "agent-join-allowed",
      type: "song.room.join",
      roomId: "1234",
      payload: { userName: "AgentOne" },
    }
  );
  expect(joined.snapshot.settings.allowAgents).toBe(true);
  expect(joined.snapshot.players.find((player) => player.id === joined.playerId)?.isAgent).toBe(
    true
  );
});

test("猜歌人类页面已关时 Agent 离房：座位转为离线保留，人类凭证仍可重连", async () => {
  const service = new SonGuessrService({ musicProvider: provider });
  const host = connection(service, "song-away-host");
  const created = (await createRoom(service, host, { allowAgents: true })) as {
    playerId: string;
    sessionToken: string;
  };
  const guest = connection(service, "song-away-guest");
  await joinRoom(service, guest, "玩家");
  const agent = connection(service, "song-away-agent");
  agent.record.isAgent = true;
  await execute(service, agent, {
    id: "song-away-claim",
    type: "mcp.claim",
    payload: { roomId: "1234", sessionToken: created.sessionToken },
  });
  await service.unregisterConnection(host.record.id);

  await execute(service, agent, {
    id: "song-away-leave",
    type: "song.room.leave",
    roomId: "1234",
    payload: {},
  });

  const seat = lastEvent<SonGuessrRoomSnapshot>(guest, "song.room.snapshot").players.find(
    (player) => player.id === created.playerId
  );
  expect(seat).toMatchObject({ online: false });
  const back = connection(service, "song-away-host-back");
  const resumed = await execute<{ playerId: string }>(service, back, {
    id: "song-away-reconnect",
    type: "song.room.reconnect",
    payload: { roomId: "1234", sessionToken: created.sessionToken },
  });
  expect(resumed.playerId).toBe(created.playerId);
});

test("猜歌 MCP 配对：Agent 接管人类座位，人类操作被服务端锁定，收回后恢复", async () => {
  const service = new SonGuessrService({ musicProvider: provider });
  const host = connection(service, "song-pair-host");
  const created = (await createRoom(service, host, { allowAgents: true })) as {
    playerId: string;
    sessionToken: string;
  };

  const agent = connection(service, "song-pair-agent");
  agent.record.isAgent = true;
  const claimed = await execute<{ playerId: string; sessionToken: string }>(service, agent, {
    id: "song-pair-claim",
    type: "mcp.claim",
    payload: { roomId: "1234", sessionToken: created.sessionToken },
  });
  expect(claimed.playerId).toBe(created.playerId);
  expect(claimed.sessionToken).not.toBe(created.sessionToken);

  const snapshot = lastEvent<SonGuessrRoomSnapshot>(host, "song.room.snapshot");
  expect(snapshot.players.find((player) => player.id === created.playerId)?.mcpControlled).toBe(
    true
  );
  const viewerState = lastEvent<SonGuessrPrivateState>(host, "song.game.privateState");
  expect(viewerState.mcpControlled).toBe(true);

  await expect(
    execute(service, host, {
      id: "song-pair-host-ready",
      type: "song.player.setReady",
      roomId: "1234",
      payload: { ready: true },
    })
  ).rejects.toMatchObject({ code: "MCP_CONTROL_ONLY" });

  await execute(service, host, { id: "song-pair-release", type: "mcp.release", payload: {} });
  await execute(service, host, {
    id: "song-pair-host-ready-after",
    type: "song.player.setReady",
    roomId: "1234",
    payload: { ready: true },
  });
});
