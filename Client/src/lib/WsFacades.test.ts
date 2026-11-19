import { afterEach, describe, expect, it, vi } from "vitest";
import * as cee from "./CEEWs";
import * as song from "./SonGuessrWs";
import * as faker from "./WhoIsFakerWs";

/** 三款游戏的 WS facade 对外同一组函数（Spec §5 客户端对等）；原始客户端各自另行导出，不在比较之列。 */
const facadeOf = (module: Record<string, unknown>) =>
  Object.entries(module)
    .filter(([name, value]) => typeof value === "function" && !name.endsWith("WsClient"))
    .map(([name]) => name)
    .sort();

describe("WS facade 形状", () => {
  it("卧底、猜歌、CEE 导出同一组连接、发送与订阅函数", () => {
    const expected = [
      "connect",
      "disconnect",
      "onMessage",
      "onStatus",
      "send",
      "waitForConnection",
    ];
    expect(facadeOf(faker)).toEqual(expected);
    expect(facadeOf(song)).toEqual(expected);
    expect(facadeOf(cee)).toEqual(expected);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  // 门面与原始连接各自导出：store 订阅走门面，换号刷新身份等走原始连接，两者必须是同一条。
  it.each([
    ["卧底", faker, faker.whoIsFakerWsClient],
    ["猜歌", song, song.sonGuessrWsClient],
    ["CEE", cee, cee.ceeWsClient],
  ] as const)("%s 的门面转发给它自己导出的那条连接", (_name, facade, client) => {
    const connect = vi.spyOn(client, "connect").mockImplementation(() => {});
    const disconnect = vi.spyOn(client, "disconnect").mockImplementation(() => {});

    facade.connect();
    facade.disconnect();

    expect(connect).toHaveBeenCalledTimes(1);
    expect(disconnect).toHaveBeenCalledTimes(1);
  });
});
