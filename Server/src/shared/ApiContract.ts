import { oc } from "@orpc/contract";
import { z } from "zod";

import { ACCOUNT_NAME_MAX_LENGTH, QQ_NUMBER_PATTERN } from "./Account";

/**
 * 账号 HTTP API 契约（oRPC，挂在 `/api/rpc`）。
 *
 * 前后端唯一来源：服务端 `implement(apiContract)`，客户端只取类型推导调用签名，
 * 运行时不打包本文件（`Index.ts` 以 `export type` 导出）。
 * 错误统一为 `ORPCError`，`code` 取服务端 `AppError.code`，`message` 为可直接展示的中文。
 */

const qqNumber = z.string().regex(QQ_NUMBER_PATTERN, "QQ 号格式不正确");
const accountName = z.string().trim().min(1, "请填写账号昵称").max(ACCOUNT_NAME_MAX_LENGTH);

export const accountProfileSchema = z.object({
  id: z.string(),
  name: z.string(),
  qqNumber: z.string(),
  /** 站内代理头像地址；首次抓取完成前为空。 */
  image: z.string().nullable(),
  showQq: z.boolean(),
  role: z.enum(["user", "admin"]),
  createdAt: z.string(),
});

/** 别人看到的资料卡：QQ 号仅在本人公开时出现。 */
export const publicProfileSchema = z.object({
  id: z.string(),
  name: z.string(),
  image: z.string().nullable(),
  qqNumber: z.string().nullable(),
});

export const apiContract = {
  account: {
    /** 发送登录验证码；`registered` 决定前端是否要求填写昵称。 */
    requestLoginCode: oc
      .input(z.object({ qqNumber }))
      .output(z.object({ registered: z.boolean(), resendAfterSeconds: z.number().int() })),
    /** 当前登录资料；未登录返回 `null`。顺带按节流刷新 QQ 头像（每次访问调用一次即可）。 */
    me: oc.output(accountProfileSchema.nullable()),
    updateProfile: oc
      .input(z.object({ name: accountName.optional(), showQq: z.boolean().optional() }))
      .output(accountProfileSchema),
    publicProfile: oc
      .input(z.object({ userId: z.string().min(1).max(64) }))
      .output(publicProfileSchema),
  },
};

export type ApiContract = typeof apiContract;
export type AccountProfile = z.infer<typeof accountProfileSchema>;
export type PublicProfile = z.infer<typeof publicProfileSchema>;

