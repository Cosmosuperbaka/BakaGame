import { memoryAdapter } from "better-auth/adapters/memory";

import { AccountService } from "../src/application/AccountService";
import { WhoIsFakerService } from "../src/application/WhoIsFakerService";
import type { AppEnv } from "../src/config/Env";
import { createAuth } from "../src/infrastructure/auth/Auth";
import type { Mailer } from "../src/infrastructure/auth/Mailer";
import { QQAvatarService } from "../src/infrastructure/auth/QQAvatar";
import { EventLogger } from "../src/infrastructure/EventLogger";
import { isAllowedOrigin } from "../src/transport/App";
import { createTestApp } from "./AppFixtures";

export const ACCOUNT_TEST_SECRET = "fixture-secret-fixture-secret-fixture-secret";

/** 记录发出的验证码，测试据此完成登录。 */
export class CapturedMailer implements Mailer {
  readonly sent: Array<{ to: string; code: string }> = [];
  failNext = false;

  async sendLoginCode(input: { to: string; code: string }): Promise<void> {
    if (this.failNext) {
      this.failNext = false;
      throw new Error("smtp down");
    }
    this.sent.push(input);
  }

  lastCodeFor(to: string): string {
    const item = [...this.sent].reverse().find((entry) => entry.to === to);
    if (!item) throw new Error(`没有发给 ${to} 的验证码`);
    return item.code;
  }
}

/** 假的 qlogo：按 QQ 号返回可控字节，记录回源次数。 */
export const createAvatarFetcher = () => {
  const versions = new Map<string, number>();
  const calls: string[] = [];
  const fetcher = (async (input: string | URL | Request) => {
    const url = new URL(String(input instanceof Request ? input.url : input));
    const qq = url.searchParams.get("nk") ?? "";
    calls.push(url.toString());
    const version = versions.get(qq) ?? 1;
    return new Response(new TextEncoder().encode(`avatar:${qq}:${version}:${url.searchParams.get("s")}`), {
      headers: { "content-type": "image/jpeg" },
    });
  }) as typeof fetch;
  return { fetcher, calls, bump: (qq: string) => versions.set(qq, (versions.get(qq) ?? 1) + 1) };
};

export const createAccountTestApp = (options: { adminQqNumbers?: string[]; now?: () => number } = {}) => {
  const env: AppEnv = {
    clientUrl: "http://localhost:5173",
    serverUrl: "http://localhost:4850",
    serverListenHost: "127.0.0.1",
    serverPort: 0,
    bangumiApiUrl: "https://api.bgm.tv",
    bangumiImageUrl: "",
  };
  const logger = new EventLogger(() => {});
  const mailer = new CapturedMailer();
  const avatarFetcher = createAvatarFetcher();
  const db: Record<string, unknown[]> = { user: [], session: [], account: [], verification: [] };
  const auth = createAuth({
    database: memoryAdapter(db as Record<string, never[]>),
    secret: ACCOUNT_TEST_SECRET,
    baseURL: env.serverUrl,
    isTrustedOrigin: (origin) => isAllowedOrigin(origin, env.clientUrl),
    secureCookies: false,
    adminQqNumbers: options.adminQqNumbers ?? [],
    mailer,
  });
  const service = new AccountService({ auth, mailer, avatars: new QQAvatarService(avatarFetcher.fetcher), logger, now: options.now });
  const { app } = createTestApp({
    env,
    logger,
    whoIsFakerService: new WhoIsFakerService({ eventLogger: logger }),
    account: { auth, service, ready: Promise.resolve() },
  });

  const rpc = async (path: string, input?: unknown, cookie?: string) => {
    const response = await app.handle(new Request(`http://localhost/api/rpc/${path}`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: env.clientUrl, ...(cookie ? { cookie } : {}) },
      body: JSON.stringify(input === undefined ? {} : { json: input }),
    }));
    const body = await response.json() as { json?: unknown };
    return { status: response.status, body: body.json as Record<string, unknown> };
  };

  /** 完整走一遍「发码 → 填码登录」，返回会话 Cookie。 */
  const signIn = async (qqNumber: string, name?: string) => {
    const sent = await rpc("account/requestLoginCode", { qqNumber });
    if (sent.status !== 200) throw new Error(`发码失败: ${JSON.stringify(sent.body)}`);
    const email = `${qqNumber}@qq.com`;
    const response = await app.handle(new Request("http://localhost/api/auth/sign-in/email-otp", {
      method: "POST",
      headers: { "content-type": "application/json", origin: env.clientUrl },
      body: JSON.stringify({ email, otp: mailer.lastCodeFor(email), ...(name ? { name } : {}) }),
    }));
    return { response, cookie: cookieOf(response) };
  };

  return { app, auth, service, mailer, avatarFetcher, db, rpc, signIn };
};

/** 把 Set-Cookie 折叠成请求用的 Cookie 头。 */
export const cookieOf = (response: Response): string =>
  response.headers.getSetCookie().map((item) => item.split(";")[0]).join("; ");
