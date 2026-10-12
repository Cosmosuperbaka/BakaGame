import { eq } from "drizzle-orm";

import type { Database } from "./Database";
import { siteConfig } from "./Schema";

/** 站点级配置：一行一个键，整体覆盖；值的结构与加密由应用层负责。 */
export interface SiteConfigRepository {
  get(key: string): Promise<unknown | null>;
  put(key: string, value: unknown, now: Date): Promise<void>;
  remove(key: string): Promise<void>;
}

export class DatabaseSiteConfigRepository implements SiteConfigRepository {
  constructor(private readonly database: Database) {}

  async get(key: string): Promise<unknown | null> {
    await this.database.ready;
    const [row] = await this.database.db.select({ value: siteConfig.value }).from(siteConfig).where(eq(siteConfig.key, key)).limit(1);
    return row?.value ?? null;
  }

  async put(key: string, value: unknown, now: Date): Promise<void> {
    await this.database.ready;
    await this.database.db.insert(siteConfig).values({ key, value, updatedAt: now })
      .onDuplicateKeyUpdate({ set: { value, updatedAt: now } });
  }

  async remove(key: string): Promise<void> {
    await this.database.ready;
    await this.database.db.delete(siteConfig).where(eq(siteConfig.key, key));
  }
}
