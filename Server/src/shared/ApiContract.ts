import { oc } from "@orpc/contract";
import { z } from "zod";

import {
  ACCOUNT_NAME_MAX_LENGTH,
  FEEDBACK_CONTENT_MAX_LENGTH,
  FEEDBACK_TITLE_MAX_LENGTH,
  PREFERENCES_MAX_BYTES,
  QQ_NUMBER_PATTERN,
} from "./Account";

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

const preferences = z.record(z.string().max(64), z.unknown()).refine(
  (value) => new TextEncoder().encode(JSON.stringify(value)).byteLength <= PREFERENCES_MAX_BYTES,
  "设置数据过大",
);

export const musicPlatformSchema = z.enum(["netease", "qq"]);

const musicAccountSchema = z.object({
  platform: musicPlatformSchema.optional(),
  userId: z.string().max(64).optional(),
  nickname: z.string().max(128),
  avatarUrl: z.string().max(1024).optional(),
  vipStatus: z.enum(["vip", "nonVip", "unknown"]).optional(),
  vipType: z.number().optional(),
  vipExpireTime: z.number().optional(),
  vipTier: z.enum(["svip", "vip", "musicPackage"]).optional(),
  vipLevel: z.number().optional(),
  vipYear: z.boolean().optional(),
});

/** 云端保存的猜歌音乐账号：cookie 在服务端加密落库，只回给本人。 */
export const musicSessionSchema = z.object({
  cookie: z.string().min(1).max(16 * 1024),
  account: musicAccountSchema,
});

export const cloudSettingsSchema = z.object({
  preferences: z.object({ value: preferences, updatedAt: z.string() }).nullable(),
  music: z.object({
    netease: musicSessionSchema.nullable(),
    qq: musicSessionSchema.nullable(),
  }),
});

export const feedbackKindSchema = z.enum(["suggestion", "bug"]);
export const feedbackStatusSchema = z.enum(["open", "processing", "resolved", "closed"]);

export const feedbackSummarySchema = z.object({
  id: z.string(),
  kind: feedbackKindSchema,
  title: z.string(),
  status: feedbackStatusSchema,
  createdAt: z.string(),
  lastReplyAt: z.string().nullable(),
  /** 有晚于本人上次查看的管理员回复。 */
  unread: z.boolean(),
});

export const feedbackReplySchema = z.object({
  id: z.number().int(),
  content: z.string(),
  createdAt: z.string(),
});

export const feedbackDetailSchema = feedbackSummarySchema.extend({
  content: z.string(),
  page: z.string().nullable(),
  replies: z.array(feedbackReplySchema),
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
  settings: {
    get: oc.output(cloudSettingsSchema),
    /** 整体覆盖偏好文档，返回服务端记录的更新时间。 */
    savePreferences: oc
      .input(z.object({ value: preferences }))
      .output(z.object({ updatedAt: z.string() })),
    /** `session` 为空表示退出该平台账号并删除云端副本。 */
    saveMusicSession: oc
      .input(z.object({ platform: musicPlatformSchema, session: musicSessionSchema.nullable() }))
      .output(z.object({ updatedAt: z.string() })),
  },
  feedback: {
    create: oc
      .input(z.object({
        kind: feedbackKindSchema,
        title: z.string().trim().min(1, "请填写标题").max(FEEDBACK_TITLE_MAX_LENGTH),
        content: z.string().trim().min(1, "请填写内容").max(FEEDBACK_CONTENT_MAX_LENGTH),
        page: z.string().max(255).optional(),
      }))
      .output(feedbackSummarySchema),
    listMine: oc
      .output(z.object({ items: z.array(feedbackSummarySchema), unread: z.number().int() })),
    /** 读取详情并标记已读。 */
    get: oc
      .input(z.object({ id: z.string().min(1).max(36) }))
      .output(feedbackDetailSchema),
  },
};

export type ApiContract = typeof apiContract;
export type AccountProfile = z.infer<typeof accountProfileSchema>;
export type PublicProfile = z.infer<typeof publicProfileSchema>;
export type CloudSettings = z.infer<typeof cloudSettingsSchema>;
export type CloudMusicSession = z.infer<typeof musicSessionSchema>;
export type MusicPlatform = z.infer<typeof musicPlatformSchema>;
export type FeedbackSummary = z.infer<typeof feedbackSummarySchema>;
export type FeedbackDetail = z.infer<typeof feedbackDetailSchema>;
export type FeedbackKind = z.infer<typeof feedbackKindSchema>;
export type FeedbackStatus = z.infer<typeof feedbackStatusSchema>;

