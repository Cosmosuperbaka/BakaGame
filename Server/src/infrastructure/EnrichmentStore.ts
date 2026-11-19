import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

/** 回填缓存的实体类型：番剧与角色共用同一张表。 */
export type EnrichmentEntity = "subject" | "character";

/** 回填缓存的图片载荷。只存**上游原始 URL**，镜像地址在读取时重写。 */
export interface BangumiEnrichment {
  /** 长条大图（`large`）：竖版作品海报、图片提示、答案卡。 */
  image?: string;
  /** 方格图（`grid`），只有角色存：列表的方形缩略图。 */
  grid?: string;
}

/**
 * Bangumi API 回填缓存：数据集是只读产物（或由更新器单独写），上游补来的图片地址
 * 只能落在这个独立的可写 SQLite 里。猜歌与 CEE 共用同一张表，所以建表、读取与合并写入
 * 只在这里写一份：两处各建各写时，一边写 `{image}` 整体覆盖另一边刚写的 `{image, grid}`，
 * 列表缩略图就会退成大图。
 *
 * 连接由调用方决定是否共享：数据 Worker 里两条链路注入同一个实例（同一个文件只开一条连接），
 * 单独构造的提供者各自打开自己的。实例不负责判断谁该关闭，谁创建谁关闭。
 */
export class EnrichmentStore {
  /** CEE 的补充资料表与目录表也建在这条连接上，所以对外暴露。 */
  readonly db: Database;

  /** `path` 缺省为内存库；落盘路径的父目录不存在时先建出来。 */
  constructor(path = ":memory:") {
    // 路径配置错误必须在启动时暴露：静默降级会让回填缓存「悄悄不生效」。
    if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
    this.db = new Database(path, { create: true });
    // 同一个文件可能被多条连接写入，互相等锁而不是直接报 busy。
    this.db.run("PRAGMA busy_timeout = 1000");
    this.db.run(`
      CREATE TABLE IF NOT EXISTS enrichment (
        entity TEXT NOT NULL, id INTEGER NOT NULL,
        payload TEXT NOT NULL, fetched_at INTEGER NOT NULL,
        PRIMARY KEY(entity, id)
      )
    `);
  }

  /** 读一条载荷；没有返回 `undefined`。载荷损坏时抛出，由调用方决定是降级还是上报。 */
  read(entity: EnrichmentEntity, id: number): BangumiEnrichment | undefined {
    const row = this.db
      .query<{ payload: string }, [string, number]>(
        "SELECT payload FROM enrichment WHERE entity = ? AND id = ?"
      )
      .get(entity, id);
    return row ? (JSON.parse(row.payload) as BangumiEnrichment) : undefined;
  }

  /** 合并写入：只覆盖本次给出的字段，已有的其他字段保留。 */
  merge(entity: EnrichmentEntity, id: number, payload: BangumiEnrichment, fetchedAt: number): void {
    this.db
      .query<null, [string, number, string, number]>(
        "INSERT INTO enrichment (entity, id, payload, fetched_at) VALUES (?,?,?,?)" +
          " ON CONFLICT(entity, id) DO UPDATE SET payload = json_patch(payload, excluded.payload)," +
          " fetched_at = excluded.fetched_at"
      )
      .run(entity, id, JSON.stringify(payload), fetchedAt);
  }

  close(): void {
    this.db.close();
  }
}
