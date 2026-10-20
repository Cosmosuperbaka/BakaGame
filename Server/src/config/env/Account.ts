import { AppError } from "../../domain/Errors";
import { QQ_NUMBER_PATTERN } from "../../shared/Account";

/** 通行密钥域名（relying party ID）的取值形状：裸域名，允许 `localhost` 这类单标签。 */
const RP_ID_PATTERN = /^[A-Za-z0-9]([A-Za-z0-9._-]*[A-Za-z0-9])?$/;

export interface SmtpEnv {
  host: string;
  port: number;
  user: string;
  pass: string;
  /** 发件人，如 `BakaGame <noreply@baka.website>`；缺省用 SMTP_USER。 */
  from: string;
}

export interface AccountEnv {
  /** Better Auth 会话签名密钥（≥ 32 字符）。 */
  secret: string;
  /** 启动时提升为管理员的 QQ 号。 */
  adminQqNumbers: string[];
  /** 验证码投递：SMTP，或仅限非生产环境的控制台输出（`MAIL_DEV_CONSOLE=true`）。 */
  mail: { kind: "smtp"; smtp: SmtpEnv } | { kind: "console" } | { kind: "none" };
  /**
   * 通行密钥的 relying party 域名（裸域名）：显式 `PASSKEY_RP_ID` 优先，否则取 `CLIENT_URL`
   * 首个来源的 hostname。
   *
   * 一旦有用户注册过密钥就不能再改：密钥按域名绑定，改了等于旧密钥全部失效。
   * 想跨子域共用（`game.` 与 `www.` 都能登录）就在第一个用户注册前固定成公共注册域。
   */
  passkeyRpId: string;
}

/**
 * QQ 昵称来源：管理员自建的 NapCat 实例（OneBot 11 HTTP）。
 *
 * 网址与令牌必须成对出现：缺一个就是配置错误，不能默默降级成「查不到昵称」——
 * 那会让新号注册以「QQ 昵称不可用」为由被拒，排查时看不出是配置漏填。
 */
export interface NapCatEnv {
  /** OneBot HTTP 基址，不含结尾斜杠。 */
  apiUrl: string;
  accessToken: string;
}

/**
 * 账号与投递凭据（T1）：随数据库一同启用，缺库时整体为空。
 * 分层口径见 `Agents/Conventions.md` §5。
 */
export interface EnvAccount {
  /** 数据库连接串；未配置时账号、云同步、后台与对局记录整体关闭（生产必填）。 */
  databaseUrl?: string;
  /** 账号系统配置：随数据库一同启用，缺数据库时为空。 */
  account?: AccountEnv;
  /** NapCat（OneBot 11）昵称来源；未配置时 QQ 昵称查询整体停用。 */
  napcat?: NapCatEnv;
}

const readSmtpEnv = (): SmtpEnv | undefined => {
  const host = Bun.env.SMTP_HOST?.trim();
  const user = Bun.env.SMTP_USER?.trim();
  const pass = Bun.env.SMTP_PASS ?? "";
  if (!host && !user && !pass) return undefined;
  if (!host || !user || !pass) {
    throw new AppError("CONFIG_ERROR", "SMTP_HOST、SMTP_USER、SMTP_PASS 必须同时配置");
  }
  const rawPort = Bun.env.SMTP_PORT?.trim() || "465";
  const port = Number(rawPort);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new AppError("CONFIG_ERROR", `环境变量 SMTP_PORT 必须为合法端口号，收到: "${rawPort}"`);
  }
  return { host, port, user, pass, from: Bun.env.MAIL_FROM?.trim() || user };
};

/**
 * 通行密钥的 relying party 域名。
 *
 * `CLIENT_URL` 是逗号分隔的来源列表，而 rpID 只有一个：默认取第一个来源的 hostname，
 * 多个前端域名要共用密钥时必须显式配 `PASSKEY_RP_ID` 成它们的公共注册域。
 */
const resolvePasskeyRpId = (clientUrl: string): string => {
  const raw = Bun.env.PASSKEY_RP_ID?.trim();
  if (raw) {
    if (!RP_ID_PATTERN.test(raw)) {
      throw new AppError(
        "CONFIG_ERROR",
        `PASSKEY_RP_ID 必须是裸域名（不含协议、端口与路径），收到: "${raw}"`
      );
    }
    return raw.toLowerCase();
  }
  for (const item of clientUrl.split(",")) {
    try {
      const hostname = new URL(item.trim()).hostname;
      if (hostname) return hostname;
    } catch {
      // 非法来源由 isAllowedOrigin 那边报错，这里继续找下一个。
    }
  }
  return "localhost";
};

const readAccountEnv = (
  databaseUrl: string | undefined,
  clientUrl: string
): AccountEnv | undefined => {
  if (!databaseUrl) return undefined;
  const secret = Bun.env.BETTER_AUTH_SECRET?.trim() ?? "";
  if (secret.length < 32) {
    throw new AppError(
      "CONFIG_ERROR",
      "配置 DATABASE_URL 时 BETTER_AUTH_SECRET 必须为至少 32 字符的随机串"
    );
  }
  const adminQqNumbers = (Bun.env.ADMIN_QQ ?? "")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
  const invalidAdmin = adminQqNumbers.find((item) => !QQ_NUMBER_PATTERN.test(item));
  if (invalidAdmin) throw new AppError("CONFIG_ERROR", `ADMIN_QQ 含非法 QQ 号: "${invalidAdmin}"`);
  const smtp = readSmtpEnv();
  const devConsole = Bun.env.MAIL_DEV_CONSOLE === "true";
  return {
    secret,
    adminQqNumbers,
    mail: smtp ? { kind: "smtp", smtp } : devConsole ? { kind: "console" } : { kind: "none" },
    passkeyRpId: resolvePasskeyRpId(clientUrl),
  };
};

const readNapCatEnv = (): NapCatEnv | undefined => {
  const apiUrl = Bun.env.QQ_NAPCAT_API_URL?.trim();
  const accessToken = Bun.env.QQ_NAPCAT_ACCESS_TOKEN?.trim();
  if (!apiUrl && !accessToken) return undefined;
  if (!apiUrl || !accessToken) {
    throw new AppError("CONFIG_ERROR", "QQ_NAPCAT_API_URL 与 QQ_NAPCAT_ACCESS_TOKEN 必须同时配置");
  }
  return { apiUrl: apiUrl.replace(/\/+$/, ""), accessToken };
};

export const readAccountGroupEnv = (clientUrl: string): EnvAccount => {
  const databaseUrl = Bun.env.DATABASE_URL?.trim() || undefined;
  return {
    databaseUrl,
    account: readAccountEnv(databaseUrl, clientUrl),
    napcat: readNapCatEnv(),
  };
};
