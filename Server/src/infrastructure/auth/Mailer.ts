import nodemailer, { type Transporter } from "nodemailer";

import type { AccountEnv, SmtpEnv } from "../../config/Env";
import { AppError } from "../../domain/Errors";
import { LOGIN_CODE_TTL_SECONDS } from "../../shared/Account";
import type { EventLogger } from "../EventLogger";

/** 账号系统唯一的外发邮件能力：登录验证码。 */
export interface Mailer {
  sendLoginCode(input: { to: string; code: string }): Promise<void>;
}

const SITE_NAME = "BakaGame";

const renderLoginCode = (code: string) => {
  const minutes = Math.round(LOGIN_CODE_TTL_SECONDS / 60);
  return {
    subject: `${SITE_NAME} 登录验证码：${code}`,
    text: `你的 ${SITE_NAME} 登录验证码是 ${code}，${minutes} 分钟内有效。\n如果不是你本人操作，请忽略这封邮件。`,
    html: [
      `<div style="font-family:'Noto Serif SC',serif;background:#f7f1e3;padding:32px;color:#3b3226">`,
      `<p style="margin:0 0 12px">你的 ${SITE_NAME} 登录验证码是</p>`,
      `<p style="margin:0 0 16px;font-size:32px;letter-spacing:8px;font-weight:700">${code}</p>`,
      `<p style="margin:0;color:#7a6c58">${minutes} 分钟内有效。如果不是你本人操作，请忽略这封邮件。</p>`,
      `</div>`,
    ].join(""),
  };
};

export class SmtpMailer implements Mailer {
  private readonly transport: Transporter;

  constructor(private readonly smtp: SmtpEnv) {
    this.transport = nodemailer.createTransport({
      host: smtp.host,
      port: smtp.port,
      // 465 为隐式 TLS；其余端口走 STARTTLS 且必须升级成功。
      secure: smtp.port === 465,
      requireTLS: smtp.port !== 465,
      auth: { user: smtp.user, pass: smtp.pass },
      connectionTimeout: 10_000,
      socketTimeout: 15_000,
    });
  }

  async sendLoginCode({ to, code }: { to: string; code: string }): Promise<void> {
    await this.transport.sendMail({ from: this.smtp.from, to, ...renderLoginCode(code) });
  }
}

/**
 * 仅限非生产环境：验证码只写本地 stdout。
 * 走 `localInfo` 而不是 `info`——验证码一旦进结构化上下文就会被 OTLP / Sentry 导出，
 * 等于把可重放的登录凭据交给第三方观测平台；本地联调只需要终端里那一行。
 */
export class ConsoleMailer implements Mailer {
  constructor(private readonly logger: EventLogger) {}

  async sendLoginCode({ to, code }: { to: string; code: string }): Promise<void> {
    this.logger.localInfo(`开发环境登录验证码 | to=${to} code=${code}`);
  }
}

/** 未配置投递方式：发码请求明确失败，而不是假装已发送。 */
export class UnavailableMailer implements Mailer {
  async sendLoginCode(): Promise<void> {
    throw new AppError("MAIL_UNAVAILABLE", "邮件服务未配置，暂时无法发送验证码");
  }
}

export const createMailer = (mail: AccountEnv["mail"], logger: EventLogger): Mailer =>
  mail.kind === "smtp" ? new SmtpMailer(mail.smtp) : mail.kind === "console" ? new ConsoleMailer(logger) : new UnavailableMailer();
