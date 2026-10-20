import type { Database } from "./Database";
import { appSetting } from "./Schema";

export interface StoredAppSetting {
  value: string;
  updatedBy: string | null;
  updatedAt: Date;
}

export interface AppSettingRepository {
  /** 整表读：只有 T3 那几条，量级固定，不做分页与按需查。 */
  loadAll(): Promise<Record<string, StoredAppSetting>>;
  set(key: string, value: string, updatedBy: string | null): Promise<void>;
}

export class DatabaseAppSettingRepository implements AppSettingRepository {
  constructor(private readonly database: Database) {}

  async loadAll(): Promise<Record<string, StoredAppSetting>> {
    await this.database.ready;
    const rows = await this.database.db
      .select({
        key: appSetting.key,
        value: appSetting.value,
        updatedBy: appSetting.updatedBy,
        updatedAt: appSetting.updatedAt,
      })
      .from(appSetting);
    const stored: Record<string, StoredAppSetting> = {};
    for (const row of rows)
      stored[row.key] = { value: row.value, updatedBy: row.updatedBy, updatedAt: row.updatedAt };
    return stored;
  }

  async set(key: string, value: string, updatedBy: string | null): Promise<void> {
    await this.database.ready;
    // 显式给 updated_at：MySQL 的 ON DUPLICATE KEY UPDATE 不走 Drizzle 的 $onUpdateFn。
    await this.database.db
      .insert(appSetting)
      .values({ key, value, updatedBy })
      .onDuplicateKeyUpdate({ set: { value, updatedBy, updatedAt: new Date() } });
  }
}
