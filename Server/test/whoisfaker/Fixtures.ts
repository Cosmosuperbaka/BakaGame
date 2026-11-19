import { createConnection, createTestContext, execute } from ".././Helpers";
import type { WhoIsFakerRole } from "../../src/shared/Index";

export interface JoinedPlayer {
  connection: ReturnType<typeof createConnection>;
  joinResult: { playerId: string };
}

// 统一封装建房，减少每个场景重复准备样板代码。
export const createRoom = async (
  service: ReturnType<typeof createTestContext>["service"],
  roomId: string,
  userName = "房主"
) => {
  const host = createConnection(service, `${roomId}-host`);
  const result = (await execute(service, host, {
    id: `${roomId}-create`,
    type: "room.create",
    payload: {
      roomId,
      name: `${roomId}-房间`,
      visibility: "public",
      allowSpectators: true,
      userName,
    },
  })) as { roomId: string; playerId: string; sessionToken: string };

  return { host, result };
};

export const joinPlayers = async (
  service: ReturnType<typeof createTestContext>["service"],
  roomId: string,
  count: number,
  prefix: string
): Promise<JoinedPlayer[]> => {
  const joined: JoinedPlayer[] = [];
  for (let index = 0; index < count; index += 1) {
    const connection = createConnection(service, `${roomId}-${prefix}-${index}`);
    const joinResult = (await execute(service, connection, {
      id: `${prefix}-join-${index}`,
      type: "room.join",
      roomId,
      payload: { userName: `${prefix}${index + 1}` },
    })) as { playerId: string };
    joined.push({ connection, joinResult });
  }
  return joined;
};

/**
 * 测试指令只认房主：让指定真人临时接过房主发 `test.setMyRole`，发完把房主交还。
 * 测试房的使用者本来就是房主，这里只是让「另一名真人改自己身份」的场景仍可构造。
 */
export const setMyRoleAs = async (
  service: ReturnType<typeof createTestContext>["service"],
  host: ReturnType<typeof createConnection>,
  hostPlayerId: string,
  player: JoinedPlayer,
  role: WhoIsFakerRole
) => {
  await execute(service, host, {
    id: `hand-host-${player.joinResult.playerId}`,
    type: "room.transferHost",
    payload: { playerId: player.joinResult.playerId },
  });
  await execute(service, player.connection, {
    id: `set-role-${role}`,
    type: "test.setMyRole",
    payload: { role },
  });
  await execute(service, player.connection, {
    id: "hand-host-back",
    type: "room.transferHost",
    payload: { playerId: hostPlayerId },
  });
};
