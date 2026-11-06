import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { TAB_TOKEN_PATTERN } from "../src/shared/TabSessionValues";
import { tabKeyOf, TabSessions } from "../src/transport/TabSessions";

const noProbe = () => undefined;

describe("标签页身份的分配与冲突判定", () => {
  test("没带令牌就发一份新身份：只存摘要，同一进程的 epoch 不变", async () => {
    const sessions = new TabSessions();
    const first = await sessions.claim("a", undefined, noProbe);
    const second = await sessions.claim("b", undefined, noProbe);

    expect(first.token).toMatch(new RegExp(TAB_TOKEN_PATTERN));
    expect(first.key).toBe(createHash("sha256").update(first.token).digest("hex"));
    expect(first.token).not.toBe(second.token);
    expect(first.rotated).toBe(false);
    expect(first.serverEpoch).toBe(second.serverEpoch);
  });

  test("刷新：旧连接已断开时带原令牌回来，身份不变", async () => {
    const sessions = new TabSessions();
    const { token } = await sessions.claim("page-1", undefined, noProbe);
    sessions.release("page-1");

    const renewed = await sessions.claim("page-2", token, noProbe);
    expect(renewed).toMatchObject({ token, rotated: false });
    expect(sessions.size).toBe(1);
  });

  test("服务端重启：没有登记过的令牌照样续用，算出同一个身份键", async () => {
    const before = new TabSessions();
    const { token, key } = await before.claim("page-1", undefined, noProbe);

    const after = new TabSessions();
    const renewed = await after.claim("page-2", token, noProbe);
    expect(renewed).toMatchObject({ token, key, rotated: false });
    expect(after.serverEpoch).not.toBe(before.serverEpoch);
  });

  test("复制标签页：现持有者应答探测，后来者换新身份，原标签页不受影响", async () => {
    const sessions = new TabSessions();
    const { token } = await sessions.claim("original", undefined, (nonce) => {
      sessions.confirmAlive("original", nonce);
    });

    const copied = await sessions.claim("copied", token, noProbe);
    expect(copied.rotated).toBe(true);
    expect(copied.token).not.toBe(token);
    // 原标签页重连时仍是它自己的身份：持有者没有被后来者顶掉。
    expect((await sessions.claim("original", token, noProbe)).rotated).toBe(false);
  });

  test("旧连接还没断但已无人应答：探测超时后判定为刷新，身份不变", async () => {
    const sessions = new TabSessions(5);
    let probed = 0;
    const { token } = await sessions.claim("stale", undefined, () => {
      probed += 1;
    });

    expect(await sessions.claim("refreshed", token, noProbe)).toMatchObject({
      token,
      rotated: false,
    });
    expect(probed).toBe(1);
  });

  test("探测途中旧连接断开：不必等到超时", async () => {
    const sessions = new TabSessions(60_000);
    const { token } = await sessions.claim("closing", undefined, () => {
      queueMicrotask(() => sessions.release("closing"));
    });

    const startedAt = performance.now();
    await expect(sessions.claim("refreshed", token, noProbe)).resolves.toMatchObject({
      rotated: false,
    });
    expect(performance.now() - startedAt).toBeLessThan(1_000);
  });

  test("探测发不出去：连接已死，直接接管", async () => {
    const sessions = new TabSessions(60_000);
    const { token } = await sessions.claim("dead", undefined, () => {
      throw new Error("socket closed");
    });

    await expect(sessions.claim("refreshed", token, noProbe)).resolves.toMatchObject({
      rotated: false,
    });
  });

  test("只有被探测的连接自己的应答才算数", async () => {
    const sessions = new TabSessions(10);
    let captured = "";
    const { token } = await sessions.claim("holder", undefined, (nonce) => {
      captured = nonce;
      sessions.confirmAlive("forger", nonce);
    });

    await expect(sessions.claim("newcomer", token, noProbe)).resolves.toMatchObject({
      rotated: false,
    });
    expect(captured).not.toBe("");
  });

  test("两条连接同时接管一份失联身份：只有一条拿到原身份", async () => {
    const sessions = new TabSessions(5);
    const { token } = await sessions.claim("stale", undefined, noProbe);

    const claims = await Promise.all([
      sessions.claim("first", token, (nonce) => sessions.confirmAlive("first", nonce)),
      sessions.claim("second", token, (nonce) => sessions.confirmAlive("second", nonce)),
    ]);

    expect(claims.filter((claim) => !claim.rotated)).toHaveLength(1);
    expect(claims.filter((claim) => claim.token === token)).toHaveLength(1);
  });

  test("连接断开即摘掉索引，表规模不超过在线连接数", async () => {
    const sessions = new TabSessions();
    await sessions.claim("a", undefined, noProbe);
    await sessions.claim("b", undefined, noProbe);
    expect(sessions.size).toBe(2);

    sessions.release("a");
    sessions.release("b");
    sessions.release("never-claimed");
    expect(sessions.size).toBe(0);
  });

  test("被顶替的旧连接随后断开，不影响新持有者", async () => {
    const sessions = new TabSessions(5);
    const { token, key } = await sessions.claim("old", undefined, noProbe);
    await sessions.claim("new", token, (nonce) => sessions.confirmAlive("new", nonce));

    sessions.release("old");
    // 新持有者还在：第三条连接拿同一份身份来领取时必须被判定为复制。
    expect((await sessions.claim("third", token, noProbe)).rotated).toBe(true);
    expect(tabKeyOf(token)).toBe(key);
  });
});
