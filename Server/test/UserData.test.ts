import { describe, expect, test } from "bun:test";

import { SettingCipher } from "../src/infrastructure/auth/SettingCipher";
import { ACCOUNT_TEST_SECRET, createAccountTestApp } from "./AccountFixtures";

const neteaseSession = {
  cookie: "MUSIC_U=fixture-cookie; __csrf=abc",
  account: { platform: "netease" as const, userId: "42", nickname: "云村村民", vipStatus: "vip" as const, vipTier: "svip" as const },
};

describe("设置云同步", () => {
  test("偏好整体覆盖，音乐账号加密落库并只回给本人", async () => {
    const { rpc, signIn, settings } = createAccountTestApp();
    const alice = await signIn("10001", "Alice");
    const bob = await signIn("10002", "Bob");

    expect((await rpc("settings/get", undefined, alice.cookie)).body).toEqual({ preferences: null, music: { netease: null, qq: null } });

    expect((await rpc("settings/savePreferences", { value: { volume: 0.4, roomSettings: { faker: { revealRoleOnDeath: true } } } }, alice.cookie)).status).toBe(200);
    expect((await rpc("settings/savePreferences", { value: { volume: 0.8 } }, alice.cookie)).status).toBe(200);
    expect((await rpc("settings/saveMusicSession", { platform: "netease", session: neteaseSession }, alice.cookie)).status).toBe(200);

    const mine = (await rpc("settings/get", undefined, alice.cookie)).body as {
      preferences: { value: unknown; updatedAt: string }; music: Record<string, unknown>;
    };
    expect(mine.preferences.value).toEqual({ volume: 0.8 });
    expect(mine.music).toEqual({ netease: neteaseSession, qq: null });

    // 库里只有密文，cookie 原文不出现。
    const stored = [...settings.rows.values()].find((row) => row.key === "music.netease")!;
    expect(typeof stored.value).toBe("string");
    expect(String(stored.value)).not.toContain("fixture-cookie");

    expect((await rpc("settings/get", undefined, bob.cookie)).body).toEqual({ preferences: null, music: { netease: null, qq: null } });

    expect((await rpc("settings/saveMusicSession", { platform: "netease", session: null }, alice.cookie)).status).toBe(200);
    expect(((await rpc("settings/get", undefined, alice.cookie)).body as { music: unknown }).music).toEqual({ netease: null, qq: null });
  });

  test("未登录、超大偏好与非法音乐账号被拒绝", async () => {
    const { rpc, signIn } = createAccountTestApp();
    const { cookie } = await signIn("10001", "Alice");

    expect((await rpc("settings/get")).status).toBe(401);
    expect((await rpc("settings/savePreferences", { value: { blob: "x".repeat(40 * 1024) } }, cookie)).status).toBe(400);
    expect((await rpc("settings/saveMusicSession", { platform: "netease", session: { cookie: "", account: { nickname: "x" } } }, cookie)).status).toBe(400);
    expect((await rpc("settings/saveMusicSession", { platform: "kugou", session: null }, cookie)).status).toBe(400);
  });

  test("密文挪到别人名下或密钥轮换后视为无数据", async () => {
    const { rpc, signIn, settings, db } = createAccountTestApp();
    const alice = await signIn("10001", "Alice");
    const bob = await signIn("10002", "Bob");
    await rpc("settings/saveMusicSession", { platform: "qq", session: { ...neteaseSession, account: { nickname: "绿钻" } } }, alice.cookie);

    const aliceId = (db.user as Array<{ id: string; email: string }>).find((user) => user.email === "10001@qq.com")!.id;
    const bobId = (db.user as Array<{ id: string; email: string }>).find((user) => user.email === "10002@qq.com")!.id;
    const token = settings.rows.get(`${aliceId}:music.qq`)!.value;
    await settings.put(bobId, "music.qq", token, new Date());
    expect(((await rpc("settings/get", undefined, bob.cookie)).body as { music: { qq: unknown } }).music.qq).toBeNull();

    const rotated = new SettingCipher(`${ACCOUNT_TEST_SECRET}-rotated`);
    expect(rotated.decrypt(String(token), aliceId, "music.qq")).toBeNull();
    expect(new SettingCipher(ACCOUNT_TEST_SECRET).decrypt(String(token), aliceId, "music.qq")).toContain("绿钻");
  });
});

describe("站内反馈", () => {
  test("登录用户提交反馈并同步 Sentry，不带邮箱与 QQ 号", async () => {
    const { rpc, signIn, sentFeedback, feedback } = createAccountTestApp();
    const { cookie } = await signIn("10001", "Alice");

    expect((await rpc("feedback/create", { kind: "bug", title: "x", content: "y" })).status).toBe(401);

    const created = await rpc("feedback/create", { kind: "bug", title: "  猜歌没声音 ", content: "点播放没反应", page: "/songuessr" }, cookie);
    expect(created.status).toBe(200);
    expect(created.body).toMatchObject({ kind: "bug", title: "猜歌没声音", status: "open", unread: false, lastReplyAt: null });

    expect(sentFeedback).toHaveLength(1);
    expect(sentFeedback[0]).toMatchObject({ name: "Alice", url: "/songuessr", tags: { "feedback.kind": "bug" } });
    expect(sentFeedback[0]!.message).toContain("点播放没反应");
    expect(JSON.stringify(sentFeedback[0])).not.toContain("10001");

    const record = feedback.records.get(String(created.body.id))!;
    expect(record.sentryEventId).toBe("event-1");
    expect(record.userAgent).toBeNull();
  });

  test("Sentry 未启用或失败时反馈照常落库", async () => {
    const { rpc, signIn, sentry, feedback } = createAccountTestApp();
    const { cookie } = await signIn("10001", "Alice");
    sentry.enabled = false;
    expect((await rpc("feedback/create", { kind: "suggestion", title: "a", content: "b" }, cookie)).status).toBe(200);
    sentry.fail = true;
    expect((await rpc("feedback/create", { kind: "suggestion", title: "c", content: "d" }, cookie)).status).toBe(200);
    expect([...feedback.records.values()].map((record) => record.sentryEventId)).toEqual([null, null]);
  });

  test("每人每小时最多 5 条，空标题被拒绝", async () => {
    const { rpc, signIn } = createAccountTestApp();
    const { cookie } = await signIn("10001", "Alice");
    expect((await rpc("feedback/create", { kind: "bug", title: "   ", content: "b" }, cookie)).status).toBe(400);
    for (let index = 0; index < 5; index += 1) {
      expect((await rpc("feedback/create", { kind: "bug", title: `t${index}`, content: "b" }, cookie)).status).toBe(200);
    }
    expect((await rpc("feedback/create", { kind: "bug", title: "t5", content: "b" }, cookie)).status).toBe(429);
  });

  test("回复产生未读，查看详情后清零；他人的反馈不可见", async () => {
    let now = Date.parse("2026-10-20T08:00:00Z");
    const { rpc, signIn, feedback } = createAccountTestApp({ now: () => now });
    const alice = await signIn("10001", "Alice");
    const bob = await signIn("10002", "Bob");
    const id = String((await rpc("feedback/create", { kind: "bug", title: "t", content: "c" }, alice.cookie)).body.id);

    now += 60_000;
    await feedback.addReply({ feedbackId: id, authorId: null, content: "已修复，请刷新", createdAt: new Date(now) });
    await feedback.update(id, { lastReplyAt: new Date(now), status: "resolved" });

    const listed = (await rpc("feedback/listMine", undefined, alice.cookie)).body as { items: Array<{ unread: boolean }>; unread: number };
    expect(listed.unread).toBe(1);
    expect(listed.items[0]!.unread).toBe(true);

    expect((await rpc("feedback/get", { id }, bob.cookie)).status).toBe(404);
    expect(((await rpc("feedback/listMine", undefined, bob.cookie)).body as { items: unknown[] }).items).toEqual([]);

    now += 60_000;
    const detail = await rpc("feedback/get", { id }, alice.cookie);
    expect(detail.body).toMatchObject({ status: "resolved", content: "c", replies: [{ content: "已修复，请刷新" }] });
    expect(((await rpc("feedback/listMine", undefined, alice.cookie)).body as { unread: number }).unread).toBe(0);
  });
});
