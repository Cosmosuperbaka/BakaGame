import { Type as t } from "@sinclair/typebox";

// 两端共用的 TypeBox/Elysia 基础 schema 助手：只收跨游戏逐字重复的原子字段约束。

export const positiveInt = t.Integer({ minimum: 1 });
export const roomId = t.String({ minLength: 1, maxLength: 32 });
export const userName = t.String({ minLength: 1, maxLength: 32 });
export const password = t.Optional(t.String({ maxLength: 64 }));
export const playerId = t.String({ minLength: 1, maxLength: 64 });
export const sessionToken = t.String({ minLength: 1, maxLength: 128 });
