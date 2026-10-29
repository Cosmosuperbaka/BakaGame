import { describe, expect, it } from "vitest";
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
    const expected = ["connect", "disconnect", "onMessage", "onStatus", "send", "waitForConnection"];
    expect(facadeOf(faker)).toEqual(expected);
    expect(facadeOf(song)).toEqual(expected);
    expect(facadeOf(cee)).toEqual(expected);
  });
});
