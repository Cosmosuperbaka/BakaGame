import { normalizeAccountName } from "../../shared/Account";
import { containsSensitiveText, SENSITIVE_TEXT_MESSAGE } from "../SensitiveText";

export type AccountNameCheck =
  | { ok: true; name: string }
  | { ok: false; code: "ACCOUNT_NAME_REQUIRED" | "TEXT_SENSITIVE"; message: string };

/**
 * 玩家自填的账号昵称（注册与改名同一口径，见 Server/docs/Account.md §1）。
 *
 * 先经共享的 `normalizeAccountName` 清洗，清洗后为空即不合法；账号昵称会出现在资料卡与排位里，
 * 属于「其他玩家可见的用户输入」，写入前必须过服务端敏感词检测（见 Server/docs/Engineering.md）。
 * 返回结果而不抛错：建号钩子要抛 Better Auth 的 `APIError`，应用层要抛 `AppError`，各自包装。
 */
export const checkAccountName = (raw: unknown): AccountNameCheck => {
  const name = typeof raw === "string" ? normalizeAccountName(raw) : "";
  if (!name) return { ok: false, code: "ACCOUNT_NAME_REQUIRED", message: "请填写账号昵称" };
  if (containsSensitiveText(name))
    return { ok: false, code: "TEXT_SENSITIVE", message: SENSITIVE_TEXT_MESSAGE };
  return { ok: true, name };
};
