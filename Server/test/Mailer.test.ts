import { describe, expect, test } from "bun:test";

import type { SmtpEnv } from "../src/config/Env";
import type { EventLogger } from "../src/infrastructure/EventLogger";
import { ConsoleMailer, createMailer, SmtpMailer, UnavailableMailer } from "../src/infrastructure/auth/Mailer";

const smtpEnv: SmtpEnv = {
  host: "smtp.example.com",
  port: 465,
  user: "bot@example.com",
  pass: "secret",
  from: "BakaGame <noreply@baka.website>",
};

const createLogger = () => {
  const logs: Array<[string, Record<string, unknown> | undefined]> = [];
  const logger = {
    info: (message: string, context?: Record<string, unknown>) => {
      logs.push([message, context]);
    },
  } as unknown as EventLogger;
  return { logs, logger };
};

/** 用捕获型假传输替换 nodemailer 实例：只校验组装好的邮件内容，不发起真实连接。 */
const captureTransport = (mailer: SmtpMailer) => {
  const sent: Array<Record<string, unknown>> = [];
  (mailer as unknown as { transport: { sendMail(message: Record<string, unknown>): Promise<unknown> } }).transport = {
    sendMail: async (message) => {
      sent.push(message);
      return { accepted: [message.to], rejected: [] };
    },
  };
  return sent;
};

describe("账号邮件投递", () => {
  test("SMTP 邮件的发件人、验证码与有效期组装", async () => {
    const mailer = new SmtpMailer(smtpEnv);
    const sent = captureTransport(mailer);
    await mailer.sendLoginCode({ to: "player@example.com", code: "123456" });

    expect(sent).toHaveLength(1);
    expect(sent[0].from).toBe("BakaGame <noreply@baka.website>");
    expect(sent[0].to).toBe("player@example.com");
    expect(String(sent[0].subject)).toContain("123456");
    expect(String(sent[0].text)).toContain("你的 BakaGame 登录验证码是 123456");
    expect(String(sent[0].text)).toContain("5 分钟");
    expect(String(sent[0].html)).toContain("123456");
    expect(String(sent[0].html)).toContain("5 分钟");
  });

  test("465 走隐式 TLS、其余端口走 STARTTLS 的构造分支都可建立", async () => {
    expect(new SmtpMailer(smtpEnv)).toBeInstanceOf(SmtpMailer);
    expect(new SmtpMailer({ ...smtpEnv, port: 587 })).toBeInstanceOf(SmtpMailer);
  });

  test("控制台投递把验证码写进日志且不落明文邮件", async () => {
    const { logs, logger } = createLogger();
    const mailer = createMailer({ kind: "console" }, logger);
    expect(mailer).toBeInstanceOf(ConsoleMailer);
    await mailer.sendLoginCode({ to: "dev@example.com", code: "888888" });
    expect(logs).toEqual([["开发环境登录验证码", { to: "dev@example.com", loginCode: "888888" }]]);
  });

  test("未配置投递方式时发码明确失败", async () => {
    const { logger } = createLogger();
    const mailer = createMailer({ kind: "none" }, logger);
    expect(mailer).toBeInstanceOf(UnavailableMailer);
    await expect(mailer.sendLoginCode({ to: "a@example.com", code: "000000" })).rejects.toMatchObject({
      code: "MAIL_UNAVAILABLE",
    });
  });

  test("工厂：smtp 配置返回 SMTP 投递器", () => {
    const { logger } = createLogger();
    const mailer = createMailer({ kind: "smtp", smtp: smtpEnv }, logger);
    expect(mailer).toBeInstanceOf(SmtpMailer);
  });
});
