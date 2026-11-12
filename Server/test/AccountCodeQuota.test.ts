import { describe, expect, test } from "bun:test";

import { createAccountTestApp } from "./AccountFixtures";

const START = Date.UTC(2026, 9, 20);
const qqOf = (index: number): string => String(100_000 + index);

/** 固定时钟：配额窗口不滑动，用例断言的是「谁被拒、谁没被牵连」。 */
const setup = async (numbers: number) => {
  let current = START;
  const ctx = createAccountTestApp({ now: () => current });
  for (let index = 0; index < numbers; index += 1) await ctx.prepareSignup(qqOf(index));
  const send = (index: number, ip: string) =>
    ctx.rpc("account/requestLoginCode", { qqNumber: qqOf(index) }, undefined, {
      "x-real-ip": ip,
    });
  return { ...ctx, send, advance: (ms: number) => (current += ms) };
};

describe("发码按来源地址限额", () => {
  test("一个来源换着号码打满自己的额度后被拒，别的来源仍能发码", async () => {
    const { send } = await setup(40);

    let accepted = 0;
    let firstRejected: Awaited<ReturnType<typeof send>> | null = null;
    for (let index = 0; index < 30; index += 1) {
      const result = await send(index, "203.0.113.7");
      if (result.status === 200) accepted += 1;
      else firstRejected ??= result;
    }
    // 单个来源一分钟只能占全站额度的一小部分，其余请求被它自己的额度挡下。
    expect(accepted).toBeGreaterThan(0);
    expect(accepted).toBeLessThan(30);
    expect(firstRejected?.status).toBe(429);
    expect(firstRejected?.body).toMatchObject({ code: "RATE_LIMITED" });

    const other = await send(35, "203.0.113.8");
    expect(other.status).toBe(200);
  });

  test("被来源额度拒绝的请求不消耗全站额度：攻击者之外的人仍用得满全站份额", async () => {
    const { send } = await setup(80);
    let attackerAccepted = 0;
    for (let index = 0; index < 60; index += 1) {
      if ((await send(index, "198.51.100.1")).status === 200) attackerAccepted += 1;
    }

    // 全站一分钟 30 次：攻击者只占走自己被放行的那些，其余 30 - attackerAccepted 次留给别人。
    let others = 0;
    for (let index = 60; index < 80; index += 1) {
      if ((await send(index, `192.0.2.${index}`)).status === 200) others += 1;
    }
    expect(attackerAccepted).toBeLessThan(30);
    expect(others).toBe(20);
  });

  test("同邮箱冷却内的重复请求不消耗来源额度与全站额度", async () => {
    const { send } = await setup(40);
    expect((await send(0, "203.0.113.9")).status).toBe(200);
    for (let repeat = 0; repeat < 50; repeat += 1) {
      expect((await send(0, "203.0.113.9")).status).toBe(429);
    }

    let accepted = 0;
    for (let index = 1; index < 20; index += 1) {
      if ((await send(index, "203.0.113.9")).status === 200) accepted += 1;
    }
    // 若重复请求吃掉了来源额度，这里一个都发不出去。
    expect(accepted).toBeGreaterThan(4);
  });

  test("窗口过去后来源额度恢复", async () => {
    const { send, advance } = await setup(40);
    let rejectedAt = -1;
    for (let index = 0; index < 30 && rejectedAt < 0; index += 1) {
      if ((await send(index, "203.0.113.20")).status === 429) rejectedAt = index;
    }
    expect(rejectedAt).toBeGreaterThan(0);

    advance(61_000);
    expect((await send(rejectedAt, "203.0.113.20")).status).toBe(200);
  });
});
