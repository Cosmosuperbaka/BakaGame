import { and, eq } from "drizzle-orm";

import type { Database } from "./Database";
import { userSetting } from "./Schema";

export interface StoredSetting {
  key: string;
  value: unknown;
  updatedAt: Date;
}

/** 一行一个键，整体覆盖写入；值的结构与加密由应用层负责。 */
export interface UserSettingRepository {
  list(userId: string): Promise<StoredSetting[]>;
  put(userId: string, key: string, value: unknown, now: Date): Promise<void>;
  remove(userId: string, key: string): Promise<void>;
}

export class DatabaseUserSettingRepository implements UserSettingRepository {
  constructor(private readonly database: Database) {}

  async list(userId: string): Promise<StoredSetting[]> {
    const db = await this.database.client();
    return db
      .select({ key: userSetting.key, value: userSetting.value, updatedAt: userSetting.updatedAt })
      .from(userSetting)
      .where(eq(userSetting.userId, userId));
  }

  async put(userId: string, key: string, value: unknown, now: Date): Promise<void> {
    const db = await this.database.client();
    await db
      .insert(userSetting)
      .values({ userId, key, value, updatedAt: now })
      .onDuplicateKeyUpdate({ set: { value, updatedAt: now } });
  }

  async remove(userId: string, key: string): Promise<void> {
    const db = await this.database.client();
    await db
      .delete(userSetting)
      .where(and(eq(userSetting.userId, userId), eq(userSetting.key, key)));
  }
}
