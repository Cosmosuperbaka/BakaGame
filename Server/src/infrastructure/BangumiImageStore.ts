import { Database } from "bun:sqlite";
import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";

/**
 * 图床分片存储。分片规则与 `tools/build_bangumi_images.py` 完全一致：
 * `crc32(path) % 分片数`，且分片数是从目录里实际存在的 `images-XX.sqlite`
 * 推断的——构建脚本用什么分片数，运行时就读什么，不硬编码 16。
 *
 * 线程模型：SQLite 连接是线程专属的。写连接只在数据 Worker 里打开（缺失下载
 * 入库，单写者）；主线程的只读路由连接与 worker 的写连接天然可以并存（SQLite
 * 多连接 + `busy_timeout` 兜底）。两端各自持有独立的 BangumiImageStore 实例。
 */
export interface BangumiImageStoreOptions {
  directory: string;
  /** 只读模式：路由使用；写操作会直接拒绝。 */
  readOnly?: boolean;
  now?: () => number;
}

export interface StoredImage {
  bytes: Uint8Array;
  contentType: string;
}

const SHARD_PATTERN = /^images-\d+\.sqlite$/;

export class BangumiImageStore {
  private readonly connections: Database[];
  private readonly readOnly: boolean;
  private readonly now: () => number;

  /** 打开目录下的全部分片；目录不存在或没有分片时返回 `undefined`（调用方按「无图床」降级）。 */
  static open(directory: string, options: { readOnly?: boolean; now?: () => number } = {}): BangumiImageStore | undefined {
    if (!existsSync(directory)) return undefined;
    const names = readdirSync(directory).filter((name) => SHARD_PATTERN.test(name)).sort();
    if (!names.length) return undefined;
    return new BangumiImageStore(directory, names, options);
  }

  private constructor(directory: string, names: string[], options: { readOnly?: boolean; now?: () => number }) {
    this.readOnly = options.readOnly ?? false;
    this.now = options.now ?? Date.now;
    this.connections = names.map((name) => {
      const target = join(directory, name);
      // bun:sqlite 显式传 `readonly: false` 会抛 SQLITE_MISUSE（与 `create: false` 同款坑），
      // 因此可写连接不传选项对象。
      const db = this.readOnly ? new Database(target, { readonly: true }) : new Database(target);
      db.exec("PRAGMA busy_timeout = 5000");
      return db;
    });
  }

  get shardCount(): number {
    return this.connections.length;
  }

  private shard(path: string): Database {
    return this.connections[Bun.hash.crc32(path) % this.connections.length]!;
  }

  has(path: string): boolean {
    return this.shard(path).query<{ present: number }, [string]>("SELECT 1 AS present FROM images WHERE path=?").get(path) !== null;
  }

  get(path: string): StoredImage | undefined {
    const row = this.shard(path).query<{ bytes: Uint8Array; content_type: string }, [string]>(
      "SELECT bytes, content_type FROM images WHERE path=?",
    ).get(path);
    return row ? { bytes: row.bytes, contentType: row.content_type } : undefined;
  }

  /** 写入（或覆盖）一张图；只读实例调用会抛错——路由侧应把写入转交数据 Worker。 */
  put(path: string, bytes: Uint8Array, contentType = "image/avif"): void {
    if (this.readOnly) throw new Error("只读图床实例不能写入");
    this.shard(path).query<never, [string, Uint8Array, string, number]>(
      "INSERT OR REPLACE INTO images (path, bytes, content_type, fetched_at) VALUES (?,?,?,?)",
    ).run(path, bytes, contentType, this.now());
  }

  count(): number {
    return this.connections.reduce(
      (sum, db) => sum + (db.query<{ n: number }, []>("SELECT count(*) AS n FROM images").get()?.n ?? 0),
      0,
    );
  }

  close(): void {
    for (const db of this.connections) db.close();
  }
}
