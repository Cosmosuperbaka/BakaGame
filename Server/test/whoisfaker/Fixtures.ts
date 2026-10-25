import { createConnection, createTestContext, execute } from ".././Helpers";

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
