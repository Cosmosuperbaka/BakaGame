import { expect, test } from "bun:test";
import { rm } from "node:fs/promises";
import { CCBCharacterWorkerProvider } from "../src/infrastructure/CCBCharacterWorkerProvider";
import { BangumiDataWorkerClient } from "../src/infrastructure/BangumiDataWorkerClient";
import { createDefaultCCBSettings } from "../src/shared/CCB";
import { createCCBCharacterFixture } from "./CCBCharacterFixtures";

// Windows Bun 1.3.14 的 rejects 匹配器会阻塞 Worker 的异步错误回包；先原生 await 再断言。
const rejectionOf = (request: Promise<unknown>) => request.then(() => null, (error: unknown) => error);

/**
 * CCB 与猜歌共用同一个 Worker，但两侧初始化分别容错：这里故意给猜歌一个不存在的库，
 * 验证它失败时 CCB 仍然可用（反之亦然）。
 */
const startCcb = (characterPath: string) => {
  const client = new BangumiDataWorkerClient();
  const ready = client.init({
    method: "init",
    song: { songPath: `missing-song-${crypto.randomUUID()}.sqlite`, characterPath },
    ccb: { characterPath },
  });
  return { client, provider: new CCBCharacterWorkerProvider(client, ready) };
};

test("角色工作线程并发查询隔离对象且关闭后拒绝请求", async () => {
  const fixture = createCCBCharacterFixture();
  const { client, provider } = startCcb(fixture.characterPath);
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

test("猜歌库缺失不影响 CCB，CCB 库缺失也不影响猜歌侧的隔离", async () => {
  const fixture = createCCBCharacterFixture();
  const { client, provider } = startCcb(fixture.characterPath);
  try {
    // 上面 startCcb 给的 songPath 不存在，CCB 仍应正常返回，证明两侧容错隔离。
    expect((await provider.searchCharacters("牧濑")).map((row) => row.id)).toEqual([1]);
  } finally {
    await client.close();
    await rm(fixture.directory, { recursive: true, force: true });
  }
}, 30_000);
