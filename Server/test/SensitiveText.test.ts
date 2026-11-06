import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { CEEService } from "../src/application/CEEService";
import { SonGuessrService } from "../src/application/SonGuessrService";
import { AppError } from "../src/domain/Errors";
import {
  assertTextAllowed,
  SENSITIVE_TEXT_MESSAGE,
  SensitiveTextFilter,
  setSensitiveTextFilterForTest,
  warmUpSensitiveText,
} from "../src/infrastructure/SensitiveText";
import type { ConnectionRecord } from "../src/shared/Index";
import { createConnection, createTestContext, execute } from "./Helpers";
import { connection as songConnection, provider } from "./songuessr/Fixtures";

// 只用占位词：测试文件里不出现真实敏感词。
const BAD = "测试违禁词A";
const filter = new SensitiveTextFilter(
  [BAD, "TestBanWord", "单", "ab", "12345"],
  ["合法测试违禁词A短语"],
  { disabledWords: [] }
);

beforeAll(() => setSensitiveTextFilterForTest(filter));
afterAll(() => setSensitiveTextFilterForTest(undefined));

const rejects = async (run: () => unknown) => {
  const error = await Promise.resolve()
    .then(run)
    .then(
      () => undefined,
      (caught: unknown) => caught
    );
  expect(error).toBeInstanceOf(AppError);
  const appError = error as AppError;
  expect(appError.code).toBe("TEXT_SENSITIVE");
  expect(appError.message).toBe(SENSITIVE_TEXT_MESSAGE);
  expect(appError.message).not.toContain(BAD);
};

describe("敏感词匹配与归一化", () => {
  test("直接命中与正常文本", () => {
    expect(filter.matches(`你好${BAD}`)).toBe(true);
    expect(filter.matches("普通的聊天内容")).toBe(false);
    expect(filter.matches("")).toBe(false);
  });

  test("全半角、大小写、零宽与控制字符不能规避", () => {
    expect(filter.matches("ＴｅｓｔＢａｎＷｏｒｄ")).toBe(true);
    expect(filter.matches("TESTBANWORD")).toBe(true);
    expect(filter.matches("测​试‍违\u0007禁词A")).toBe(true);
  });

  test("字符间插空格与标点不能规避", () => {
    expect(filter.matches("测 试 违 禁 词 A")).toBe(true);
    expect(filter.matches("测.试-违_禁!词。A")).toBe(true);
    expect(filter.matches("T.e.s.t B-a-n W-o-r-d")).toBe(true);
  });

  test("繁体写法同样命中", () => {
    const traditional = new SensitiveTextFilter(["违禁测试"]);
    expect(traditional.matches("違禁測試")).toBe(true);
  });

  test("单字词与过短 ASCII 词、纯数字词不启用", () => {
    expect(filter.matches("单")).toBe(false);
    expect(filter.matches("ab")).toBe(false);
    expect(filter.matches("12345")).toBe(false);
  });

  test("ASCII 词按整词判定，不误伤更长的单词", () => {
    expect(filter.matches("xxTestBanWordyy")).toBe(false);
    expect(filter.matches("say TestBanWord now")).toBe(true);
  });

  test("白名单短语放行，跨出白名单边界的命中照常拦截", () => {
    expect(filter.matches("合法测试违禁词A短语")).toBe(false);
    expect(filter.matches(`合法测试违禁词A短语${BAD}`)).toBe(true);
  });

  test("停用词不再命中", () => {
    const disabled = new SensitiveTextFilter(["常见误伤词"], [], { disabledWords: ["常见误伤词"] });
    expect(disabled.matches("常见误伤词")).toBe(false);
  });

  test("长文本保持线性耗时", () => {
    const text = "你好世界".repeat(250_000);
    const started = performance.now();
    expect(filter.matches(text)).toBe(false);
    expect(performance.now() - started).toBeLessThan(3_000);
  });

  test("正式词表可加载，且放行常见玩家输入", () => {
    setSensitiveTextFilterForTest(undefined);
    expect(warmUpSensitiveText()).toBeGreaterThan(1_000);
    expect(() => assertTextAllowed("我的房间", "小明", "今天天气不错")).not.toThrow();
    setSensitiveTextFilterForTest(filter);
  });
});

describe("入口拒绝", () => {
  test("assertTextAllowed 的错误不回显命中词", async () => {
    await rejects(() => assertTextAllowed("正常", BAD));
  });

  test("谁是卧底：房间名、昵称、改名、聊天", async () => {
    const { service } = createTestContext();
    const create = (id: string, over: Record<string, string>) =>
      execute(service, createConnection(service, id), {
        id: `c-${id}`,
        type: "room.create",
        payload: {
          roomId: "1234",
          name: "房间",
          userName: "房主",
          visibility: "public",
          allowSpectators: true,
          ...over,
        },
      });
    await rejects(() => create("a", { name: BAD }));
    await rejects(() => create("b", { userName: BAD }));
    await create("host", {});

    const guest = createConnection(service, "guest");
    await rejects(() =>
      execute(service, guest, {
        id: "j1",
        type: "room.join",
        roomId: "1234",
        payload: { userName: `测试${BAD}` },
      })
    );
    await execute(service, guest, {
      id: "j2",
      type: "room.join",
      roomId: "1234",
      payload: { userName: "访客" },
    });
    await rejects(() =>
      execute(service, guest, { id: "r", type: "player.rename", payload: { name: BAD } })
    );
    await rejects(() =>
      execute(service, guest, { id: "chat", type: "chat.send", payload: { text: `x ${BAD}` } })
    );
    await execute(service, guest, { id: "ok", type: "chat.send", payload: { text: "你好" } });
    await service.drainPendingWrites();
  });

  test("猜歌：房间名、昵称、聊天、改名设置", async () => {
    const service = new SonGuessrService({ musicProvider: provider, random: { nextInt: () => 0 } });
    const create = (id: string, over: Record<string, string>) =>
      service.execute(songConnection(service, id).record.id, {
        id: `c-${id}`,
        type: "song.room.create",
        payload: {
          roomId: "1234",
          name: "房间",
          userName: "房主",
          visibility: "public",
          allowSpectators: true,
          ...over,
        },
      } as never);
    await rejects(() => create("a", { name: BAD }));
    await rejects(() => create("b", { userName: BAD }));
    const host = songConnection(service, "host");
    await service.execute(host.record.id, {
      id: "c",
      type: "song.room.create",
      payload: {
        roomId: "1234",
        name: "房间",
        userName: "房主",
        visibility: "public",
        allowSpectators: true,
      },
    } as never);
    await rejects(() =>
      service.execute(host.record.id, {
        id: "chat",
        type: "song.chat.send",
        payload: { text: BAD },
      } as never)
    );
    await rejects(() =>
      service.execute(host.record.id, {
        id: "u",
        type: "song.room.updateSettings",
        payload: { name: BAD },
      } as never)
    );
  });

  test("猜角色：房间名、昵称、聊天、自填提示；搜索框不检测", async () => {
    const unused = async (): Promise<never> => {
      throw new AppError("UNUSED", "测试不读取数据");
    };
    let searched = 0;
    const service = new CEEService({
      data: {
        searchCharacters: async () => {
          searched++;
          return [];
        },
        searchSubjects: unused,
        getSubjectCharacters: unused,
        getSubjects: unused,
        getRawCharacter: unused,
        getCharacter: unused,
        chooseRandomCharacter: unused,
        importDirectory: unused,
        resolveCharacterImage: unused,
        resolveSubjectImage: unused,
        close() {},
      },
    });
    const record = (id: string): ConnectionRecord => {
      const created: ConnectionRecord = {
        id,
        lobbySubscribed: false,
        send: () => {},
        close: () => {},
      };
      service.registerConnection(created);
      return created;
    };
    const run = (id: string, message: Record<string, unknown>) =>
      service.execute(id, { id: crypto.randomUUID(), ...message } as never);
    const room = {
      source: "native",
      roomId: "1234",
      name: "房间",
      userName: "房主",
      visibility: "public",
      allowSpectators: true,
    };
    const create = (id: string, over: Record<string, string>) =>
      run(record(id).id, {
        type: "cee.room.create",
        payload: { ...room, ...over },
      });
    await rejects(() => create("a", { name: BAD }));
    await rejects(() => create("b", { userName: BAD }));

    const host = record("host");
    const entered = (await run(host.id, {
      type: "cee.room.create",
      payload: room,
    })) as { sessionToken: string };
    const sessionToken = entered.sessionToken;
    await rejects(() =>
      run(record("g").id, { type: "cee.room.join", roomId: "1234", payload: { userName: BAD } })
    );
    await rejects(() =>
      run(host.id, { type: "cee.chat.send", roomId: "1234", sessionToken, payload: { text: BAD } })
    );
    await rejects(() =>
      run(host.id, {
        type: "cee.game.setAnswer",
        roomId: "1234",
        sessionToken,
        payload: { characterId: 1, hints: ["正常", BAD] },
      })
    );
    // 搜索框不受影响：命中词出现在关键词里也照常进入检索。
    await run(host.id, {
      type: "cee.character.search",
      roomId: "1234",
      sessionToken,
      payload: { keyword: BAD },
    }).catch(() => undefined);
    expect(searched).toBe(1);
    await service.close();
  });
});
