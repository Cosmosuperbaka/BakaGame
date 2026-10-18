import { eq } from "drizzle-orm";
import type { ClientChannelStore, StoredClientDevice } from "../../infrastructure/ClientChannel";
import type { Database } from "./Database";
import { clientChannelDevice } from "./Schema";

const toRow = (device: StoredClientDevice) => ({
  clientId: device.clientId,
  clientType: device.clientType,
  platform: device.platform,
  keyAlgorithm: device.keyAlgorithm,
  publicKey: device.publicKey,
  keyProtection: device.keyProtection,
  attestationLevel: device.attestationLevel ?? null,
  registeredAt: new Date(device.registeredAt),
  lastSeenAt: new Date(device.lastSeenAt),
});

const fromRow = (row: typeof clientChannelDevice.$inferSelect): StoredClientDevice => ({
  clientId: row.clientId,
  clientType: row.clientType as StoredClientDevice["clientType"],
  platform: row.platform,
  keyAlgorithm: row.keyAlgorithm as StoredClientDevice["keyAlgorithm"],
  publicKey: row.publicKey,
  keyProtection: row.keyProtection as StoredClientDevice["keyProtection"],
  attestationLevel: (row.attestationLevel ?? undefined) as StoredClientDevice["attestationLevel"],
  registeredAt: row.registeredAt.getTime(),
  lastSeenAt: row.lastSeenAt.getTime(),
});

/**
 * 设备公钥表。重装系统或清掉本地密钥会生成新公钥，也就是一条新行——
 * 这是刻意的：身份绑定密钥而不是绑定「这台机器」，泄露的密钥吊销后不会误伤别人。
 */
export class ClientChannelRepository implements ClientChannelStore {
  constructor(private readonly database: Database) {}
  async save(device: StoredClientDevice): Promise<void> {
    await this.database.ready;
    await this.database.db
      .insert(clientChannelDevice)
      .values(toRow(device))
      .onDuplicateKeyUpdate({
        set: {
          keyProtection: device.keyProtection,
          // 重新注册就按这一次的结果覆盖：上次验出的档位不能替「密钥已换」担保。
          attestationLevel: device.attestationLevel ?? null,
          lastSeenAt: new Date(device.lastSeenAt),
        },
      });
  }
  async find(clientId: string): Promise<StoredClientDevice | undefined> {
    await this.database.ready;
    const rows = await this.database.db
      .select()
      .from(clientChannelDevice)
      .where(eq(clientChannelDevice.clientId, clientId))
      .limit(1);
    return rows[0] ? fromRow(rows[0]) : undefined;
  }
  async touch(clientId: string, at: number): Promise<void> {
    await this.database.ready;
    await this.database.db
      .update(clientChannelDevice)
      .set({ lastSeenAt: new Date(at) })
      .where(eq(clientChannelDevice.clientId, clientId));
  }
}
