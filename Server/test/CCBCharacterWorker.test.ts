import { expect, test } from "bun:test";
import { rm } from "node:fs/promises";
import { CCBCharacterWorkerProvider } from "../src/infrastructure/CCBCharacterWorkerProvider";
import { BangumiWorkerProvider } from "../src/infrastructure/BangumiWorkerProvider";
import { BangumiDataWorkerClient } from "../src/infrastructure/BangumiDataWorkerClient";
import { createDefaultCCBSettings } from "../src/shared/CCB";
import { createCCBCharacterFixture } from "./CCBCharacterFixtures";

// Windows Bun 1.3.14 的 rejects 匹配器会阻塞 Worker 的异步错误回包；先原生 await 再断言。
const rejectionOf = (request: Promise<unknown>) => request.then(() => null, (error: unknown) => error);

/**
 * CCB 与猜歌共用同一个 Worker、**同一个数据集文件**（单库）。
 * 初始化仍分别容错：库缺失时两个门面各报自己的错误码，不互相顶替。
 */
const startCcb = (dbPath: string) => {
  const client = new BangumiDataWorkerClient();
  const ready = client.init({ method: "init", song: { dbPath }, ccb: { dbPath } });
  return { client, provider: new CCBCharacterWorkerProvider(client, ready) };
};

test("角色工作线程并发查询隔离对象且关闭后拒绝请求", async () => {
  const fixture = createCCBCharacterFixture();
  const { client, provider } = startCcb(fixture.dbPath);
  try {
    const settings = { ...createDefaultCCBSettings(), startYear: 2020, endYear: 2020, topNSubjects: 1 };
    const [characters, subjects, selected] = await Promise.all([
      provider.searchCharacters("牧濑"), provider.searchSubjects("游戏"), provider.chooseRandomCharacter(settings, () => 0),
    ]);
    expect(characters.map((row) => row.id)).toEqual([1]);
    expect(subjects.map((row) => row.id)).toEqual([11]);
    expect(selected.id).toBe(1);
    selected.characterTags.push("客户端修改");
    expect((await provider.getCharacter(1, settings)).characterTags).toEqual(["蓝发", "眼镜"]);
    expect((await provider.getRawCharacter(1)).aliases).toEqual(["助手", "Christina"]);
    expect((await provider.getSubjectCharacters(10)).map((row) => row.id)).toEqual([1,2]);
    expect(await provider.resolveCharacterImage(1)).toBeUndefined();
    expect(await rejectionOf(provider.importDirectory(1))).toMatchObject({ code: "CCB_IMPORT_UNAVAILABLE" });
    expect(await rejectionOf(provider.getCharacter(999, settings))).toMatchObject({ code: "CCB_CHARACTER_NOT_FOUND" });
  } finally {
    await client.close();
    await rm(fixture.directory, { recursive: true, force: true });
  }
  expect(await rejectionOf(provider.searchCharacters("牧濑"))).toMatchObject({ code: "BANGUMI_DATA_UNAVAILABLE" });
  // 真实 Worker 的一次 init 要同时建两条数据链路， bun test 里加载 TS Worker 另有转译开销。
}, 30_000);

test("缺失数据文件的初始化失败以业务错误返回，不产生未处理拒绝", async () => {
  const { client, provider } = startCcb(`missing-${crypto.randomUUID()}.sqlite`);
  expect(await rejectionOf(provider.searchCharacters("角色"))).toMatchObject({ code: "CCB_DATA_UNAVAILABLE" });
  await client.close();
});

test("库缺失时两个门面各报自己的错误码，不互相顶替", async () => {
  const missing = `missing-${crypto.randomUUID()}.sqlite`;
  const client = new BangumiDataWorkerClient();
  const ready = client.init({ method: "init", song: { dbPath: missing }, ccb: { dbPath: missing } });
  const song = new BangumiWorkerProvider(client, ready);
  const ccb = new CCBCharacterWorkerProvider(client, ready);
  try {
    // 两侧初始化各自记错：猜歌报 BANGUMI_*、CCB 报 CCB_*，错误码不会串到对面。
    expect(await rejectionOf(song.searchSubjects("测试"))).toMatchObject({ code: "BANGUMI_DATA_UNAVAILABLE" });
    expect(await rejectionOf(ccb.searchCharacters("角色"))).toMatchObject({ code: "CCB_DATA_UNAVAILABLE" });
  } finally {
    await client.close();
  }
}, 30_000);
