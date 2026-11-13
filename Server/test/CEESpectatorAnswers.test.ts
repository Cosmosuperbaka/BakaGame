import { afterEach, describe, expect, test } from "bun:test";
import { Value } from "@sinclair/typebox/value";
import { CEESettingsSchema, createDefaultCEESettings, parseCEESettings } from "../src/shared/CEE";
import { ceeTestHarness, type CEETestClient } from "./CEENativeFixtures";

// 旁观与「中途加入」都零门槛可得，所以「不在对局中」不能等于「可以看答案」：
// 局中的旁观者与中途加入者拿不到答案和他人的猜测，揭晓后才公开；房主打开开关则保持观战体验。
// 已经答完（猜中、用尽、认输）的正式玩家不在此列，他们的视图保持原样。

const active: ReturnType<typeof ceeTestHarness>[] = [];
const harness = () => {
  const result = ceeTestHarness();
  active.push(result);
  return result;
};
afterEach(() => {
  active.splice(0).forEach((test) => test.service.close());
});

const ANSWER_CLUES = ["角色1", "Character 1", "images.invalid/1.jpg"];

type Harness = ReturnType<typeof harness>;

/** 序列化后全文搜索：字段缺席才算真的没下发，字段值被置空不算数。 */
const wire = (client: CEETestClient) => JSON.stringify(client.sent);
const expectNoAnswer = (client: CEETestClient) => {
  for (const clue of ANSWER_CLUES) expect(wire(client)).not.toContain(clue);
};

interface Scene {
  h: Harness;
  host: CEETestClient;
  guest: CEETestClient;
  /** 开局前主动切成旁观者。 */
  spectator: CEETestClient;
  /** 局中才进房：只观战，下一局才能参加。 */
  late: CEETestClient;
}

/** 走到猜题阶段：host 与 guest 各猜错一次（猜的都不是答案角色 1）。 */
const startPlaying = async (settings: Parameters<Harness["configure"]>[1] = {}) => {
  const h = harness();
  const host = await h.create();
  const guest = await h.join("玩家");
  const spectator = await h.join("旁观者");
  await h.configure(host, settings);
  await h.send(spectator, "cee.player.spectate", { spectator: true });
  await h.ready(guest);
  await h.send(host, "cee.game.start", {});
  await h.guess(host, 3);
  await h.guess(guest, 4);
  const late = await h.join("迟到者");
  return { h, host, guest, spectator, late } satisfies Scene;
};

describe("CEE 旁观者的答案可见性", () => {
  test("缺省关闭：局中旁观者与中途加入者的私有态与全部下行帧里搜不到答案", async () => {
    const { h, spectator, late, host } = await startPlaying();
    expect(h.snapshot(host).phase).toBe("guessing");
    for (const viewer of [spectator, late]) {
      const state = h.privateState(viewer);
      expect(state.answer).toBeNull();
      expect(state.guesses).toEqual([]);
      expect(state.bannedCharacterIds).toEqual([]);
      expectNoAnswer(viewer);
    }
    // 参与者自己的视图不变：本人的猜测照常可见。
    expect(h.privateState(host).guesses.map((guess) => guess.playerId)).toEqual([host.id!]);
  });

  test("全局禁选下旁观位也拿不到他人猜过的角色名单，参与者照旧", async () => {
    const { h, host, guest, spectator, late } = await startPlaying({ globalPick: true });
    expect(h.privateState(guest).bannedCharacterIds).toContain(3);
    for (const viewer of [spectator, late])
      expect(h.privateState(viewer).bannedCharacterIds).toEqual([]);
    expect(h.privateState(host).bannedCharacterIds).toContain(4);
  });

  test("揭晓后旁观者与中途加入者拿得到答案和全部猜测", async () => {
    const { h, host, spectator, late } = await startPlaying();
    await h.guess(host, 1);
    expect(h.snapshot(host).phase).toBe("settled");
    for (const viewer of [spectator, late]) {
      expect(h.privateState(viewer).answer?.id).toBe(1);
      expect(h.privateState(viewer).guesses.length).toBeGreaterThanOrEqual(3);
      expect(wire(viewer)).toContain("角色1");
    }
  });

  test("开关打开：局中旁观者与中途加入者照常看得到答案与全部猜测", async () => {
    const { h, spectator, late, host } = await startPlaying({ spectatorsSeeAnswers: true });
    expect(h.snapshot(host).settings.spectatorsSeeAnswers).toBe(true);
    for (const viewer of [spectator, late]) {
      expect(h.privateState(viewer).answer?.id).toBe(1);
      expect(h.privateState(viewer).guesses).toHaveLength(2);
    }
  });

  test("开关只管旁观：局中的普通玩家不因它看到答案，答完的正式玩家保持原样", async () => {
    const { h, host, guest } = await startPlaying({
      spectatorsSeeAnswers: true,
      nonstopMode: true,
    });
    expect(h.privateState(guest).answer).toBeNull();
    // 认输的正式玩家看得到答案（既有行为，不随开关变化）。
    await h.send(host, "cee.game.surrender", {});
    expect(h.privateState(host).answer?.id).toBe(1);
    expect(h.privateState(guest).answer).toBeNull();
  });

  test("关着开关时答完的正式玩家仍看得到答案", async () => {
    const { h, host, guest } = await startPlaying({ nonstopMode: true });
    await h.send(host, "cee.game.surrender", {});
    expect(h.privateState(host).answer?.id).toBe(1);
    expect(h.privateState(guest).answer).toBeNull();
  });

  test("出题人与其队友局中看得到答案，不受开关影响", async () => {
    const h = harness();
    const host = await h.create();
    const mate = await h.join("队友");
    const guest = await h.join("猜题者");
    await h.configure(host, {});
    await h.send(host, "cee.player.team", { team: 1 });
    await h.send(mate, "cee.player.team", { team: 1 });
    await h.chooseSetter(host, host.id!);
    await h.send(host, "cee.game.setAnswer", { characterId: 1, hints: ["手动线索"] });
    expect(h.privateState(host).answer?.id).toBe(1);
    expect(h.privateState(mate).answer?.id).toBe(1);
    expect(h.privateState(guest).answer).toBeNull();
  });

  test("Agent 中途加入走同一份视图：局中同样拿不到答案", async () => {
    const { h } = await startPlaying({ allowAgents: true });
    const agent = h.connect("旁观Agent");
    agent.record.isAgent = true;
    await h.send(agent, "cee.room.join", { userName: "旁观Agent" });
    expect(h.privateState(agent).answer).toBeNull();
    expect(h.privateState(agent).guesses).toEqual([]);
    expectNoAnswer(agent);
  });

  test("局中不能把自己切成旁观者来换取答案", async () => {
    const { h, guest } = await startPlaying();
    await expect(h.send(guest, "cee.player.spectate", { spectator: true })).rejects.toMatchObject({
      code: "INVALID_PHASE",
    });
    expect(h.privateState(guest).answer).toBeNull();
  });

  test("设置契约只接受布尔值；导入旧设置文件按关闭补齐，旧房间缺字段按关闭处理", () => {
    expect(Value.Check(CEESettingsSchema, createDefaultCEESettings(2026))).toBe(true);
    expect(createDefaultCEESettings(2026).spectatorsSeeAnswers).toBe(false);
    expect(
      Value.Check(CEESettingsSchema, { ...createDefaultCEESettings(2026), spectatorsSeeAnswers: 1 })
    ).toBe(false);
    const { spectatorsSeeAnswers: _omitted, ...legacy } = createDefaultCEESettings(2026);
    expect(parseCEESettings(legacy).spectatorsSeeAnswers).toBe(false);
  });

  test("停机快照经磁盘往返后恢复：开着的保持开着，旧快照缺字段按关闭处理", async () => {
    const restoredViewer = async (spectatorsSeeAnswers: boolean | undefined) => {
      const before = await startPlaying(spectatorsSeeAnswers ? { spectatorsSeeAnswers: true } : {});
      const rooms = JSON.parse(JSON.stringify(before.h.service.exportSnapshots())) as Array<{
        settings: { spectatorsSeeAnswers?: boolean };
      }>;
      // 旧快照落盘时还没有这个字段。
      if (spectatorsSeeAnswers === undefined) delete rooms[0]!.settings.spectatorsSeeAnswers;
      const after = harness();
      expect(after.service.restoreSnapshots(rooms as never, before.h.now())).toBe(1);
      const back = after.connect("旁观者回来");
      await after.send(back, "cee.room.reconnect", {
        roomId: "1234",
        sessionToken: before.spectator.token!,
      });
      return after.privateState(back);
    };
    expect((await restoredViewer(true)).answer?.id).toBe(1);
    const legacy = await restoredViewer(undefined);
    expect(legacy.answer).toBeNull();
    expect(legacy.guesses).toEqual([]);
  });
});
