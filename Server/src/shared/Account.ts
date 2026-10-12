// ==================== 账号共享常量（前后端唯一来源） ====================

/** QQ 号：首位非零，5~11 位数字（与腾讯号段一致）。 */
export const QQ_NUMBER_PATTERN = /^[1-9]\d{4,10}$/;
/** 登录邮箱只接受 `QQ号@qq.com`：账号身份由 QQ 号锚定。 */
export const QQ_EMAIL_PATTERN = /^([1-9]\d{4,10})@qq\.com$/;

export const ACCOUNT_NAME_MAX_LENGTH = 24;
export const LOGIN_CODE_LENGTH = 6;
/** 验证码输入校验（前端输入框与测试共用）。 */
export const LOGIN_CODE_PATTERN = /^\d{6}$/;
/** 验证码有效期（秒）。 */
export const LOGIN_CODE_TTL_SECONDS = 300;
/** 同一邮箱两次发码的最小间隔（秒），前端倒计时与后端限流共用。 */
export const LOGIN_CODE_RESEND_SECONDS = 60;

/** 账号 HTTP 前缀：Better Auth 与 oRPC 都挂在 `/api` 下，边缘才会放行到源站。 */
export const AUTH_BASE_PATH = "/api/auth";
export const ACCOUNT_AVATAR_PATH = "/api/account/avatar";

export const qqEmailOf = (qqNumber: string): string => `${qqNumber}@qq.com`;

export const qqNumberOfEmail = (email: string): string | undefined =>
  QQ_EMAIL_PATTERN.exec(email.trim().toLowerCase())?.[1];

/** QQ 官方头像地址：只在注册确认时由前端直接展示（此时 QQ 号就是用户自己刚输入的）。 */
export const qlogoUrlOf = (qqNumber: string, size: 100 | 640 = 640): string =>
  `https://q1.qlogo.cn/g?b=qq&nk=${qqNumber}&s=${size}`;

/**
 * 站内头像地址：经源站代理，URL 只含用户 ID，不暴露 QQ 号（QQ 号默认隐私）。
 * `version` 是头像字节摘要，变化即换 URL，浏览器缓存因此可以永久有效。
 */
export const accountAvatarUrlOf = (userId: string, version: string): string =>
  `${ACCOUNT_AVATAR_PATH}/${encodeURIComponent(userId)}?v=${encodeURIComponent(version)}`;

/** 账号昵称规整：折叠空白、去控制字符、按码点截断。空串表示不合法。 */
export const normalizeAccountName = (raw: string): string =>
  Array.from(raw.replace(/[\u0000-\u001f\u007f\u200b-\u200f\u2028-\u202e\u2060-\u206f\ufeff]/g, "").replace(/\s+/g, " ").trim())
    .slice(0, ACCOUNT_NAME_MAX_LENGTH)
    .join("");
