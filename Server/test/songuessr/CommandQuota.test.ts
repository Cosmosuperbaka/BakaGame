import { describe, expect, test } from "bun:test";

import { SonGuessrService } from "../../src/application/SonGuessrService";
import {
  COMMAND_RATE_LIMIT_PER_CONNECTION,
  COMMAND_RATE_LIMIT_WINDOW_MS,
} from "../../src/config/Constants";
import type { SonGuessrClientMessage } from "../../src/shared/Index";
import {
  connection,
  createRoom,
  execute,
  joinRoom,
  provider,
  type TestConnection,
} from "./Fixtures";

// 猜歌的每连接命令总额度：与卧底、猜猜呗同一个窗口与额度，任何命令先扣它。

const setup = async () => {
  let clock = 1_000_000;
  const service = new SonGuessrService({ musicProvider: provider, now: () => clock });
  const host = connection(service, "q-host");
  const guest = connection(service, "q-guest");
  await createRoom(service, host);
  await joinRoom(service, guest, "访客");
  /** 发命令，返回错误码（成功返回 "ok"）。 */
  const send = async (
    who: TestConnection,
    type: string,
    payload: Record<string, unknown> = {}
  ): Promise<string> => {
    try {
      await execute(service, who, {
        id: "q",
        type,
        roomId: "1234",
        payload,
      } as SonGuessrClientMessage);
      return "ok";
    } catch (error) {
      return (error as { code?: string }).code ?? "unknown";
    }
  };
  // 建房与加入各占一份总额度；窗口推过去再开始计，让每条用例从满额度起算。
  clock += COMMAND_RATE_LIMIT_WINDOW_MS + 1;
  return {
    send,
    host,
    guest,
    advance: (milliseconds: number) => {
      clock += milliseconds;
    },
  };
};

describe("额度取值的依据", () => {
  test("总额度：每秒 8 条，高于客户端草稿节流（每秒不到 5 条）、低于脚本循环", () => {
    const perSecond = COMMAND_RATE_LIMIT_PER_CONNECTION / (COMMAND_RATE_LIMIT_WINDOW_MS / 1000);
    expect(perSecond).toBeGreaterThanOrEqual(5);
    expect(perSecond).toBeLessThanOrEqual(10);
  });
});

describe("猜歌的每连接命令总额度", () => {
  test("满额度放行，多一条回 RATE_LIMITED，窗口过后恢复；额度按连接计", async () => {
    const { host, guest, send, advance } = await setup();
    for (let index = 0; index < COMMAND_RATE_LIMIT_PER_CONNECTION; index += 1)
      expect(await send(host, "song.room.requestSync")).toBe("ok");
    expect(await send(host, "song.room.requestSync")).toBe("RATE_LIMITED");
    expect(await send(guest, "song.room.requestSync")).toBe("ok");
    advance(COMMAND_RATE_LIMIT_WINDOW_MS + 1);
    expect(await send(host, "song.room.requestSync")).toBe("ok");
  });

  test("额度先于守卫扣：每条都被守卫拒绝的命令同样会被限流", async () => {
    const { guest, send } = await setup();
    // 非房主发房主命令：每条都是守卫拒绝。
    for (let index = 0; index < COMMAND_RATE_LIMIT_PER_CONNECTION; index += 1)
      expect(await send(guest, "song.game.start")).not.toBe("RATE_LIMITED");
    expect(await send(guest, "song.game.start")).toBe("RATE_LIMITED");
  });
});
