import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { Type } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
import { LRUCache } from "lru-cache";
import PQueue from "p-queue";
import { AppError } from "../domain/Errors";
import { rewriteBangumiImageUrl } from "./BangumiProvider";
import type { CCBDirectoryResult } from "../shared/CCB";
import type { CCBDataOptions } from "./CCBData";

const CharacterResponse = Type.Object({
  name: Type.Optional(Type.String()), summary: Type.Optional(Type.String()),
  gender: Type.Optional(Type.Union([Type.String(), Type.Number(), Type.Null()])),
  images: Type.Optional(Type.Record(Type.String(), Type.Union([Type.String(), Type.Null()]))),
  stat: Type.Optional(Type.Object({ collects: Type.Optional(Type.Number()), comments: Type.Optional(Type.Number()) })),
  infobox: Type.Optional(Type.Array(Type.Object({ key: Type.String(), value: Type.Unknown() }))),
});
const SubjectResponse = Type.Object({
  images: Type.Optional(Type.Record(Type.String(), Type.Union([Type.String(), Type.Null()]))),
});
const DirectoryPage = Type.Object({
  total: Type.Integer({ minimum: 0 }), data: Type.Array(Type.Object({ id: Type.Integer({ minimum: 1 }) }), { maxItems: 100 }),
});

type ImageEntity = "character" | "subject";
const MISS_TTL_MS = 300_000;

/** 依次回退 `medium / large / common / grid`，只认 http(s) 地址。 */
function pickImage(images: Record<string, string | null> | undefined): string | undefined {
  const source = images ?? {};
  return [source.medium, source.large, source.common, source.grid].find((candidate): candidate is string => {
    if (!candidate) return false;
    try { return ["https:", "http:"].includes(new URL(candidate).protocol); } catch { return false; }
  });
}

export interface CCBCharacterSupplement {
  name?: string;
  nameCn?: string;
  aliases?: string[];
  summary?: string;
  gender?: "male" | "female";
  popularity?: number;
}

/** 与 LocalBangumiProvider 共用图片表；可变角色资料与目录有各自的版本表。 */
export class CCBEnrichment {
  readonly db: Database;
  private readonly queue = new PQueue({ concurrency: 3 });
  /** 键为 `实体:编号`：角色立绘与作品封面各自合并、各自负缓存 */
  private readonly inFlight = new Map<string, Promise<string | undefined>>();
  private readonly misses = new LRUCache<string, number>({ max: 1024 });
  private readonly now: () => number;
  private readonly fetcher: NonNullable<CCBDataOptions["fetcher"]>;
  private readonly apiBase: string;
  private readonly imageBase: string;
  private cooldownUntil = 0;
  private closed = false;

  constructor(options: CCBDataOptions) {
    if (options.enrichmentPath && options.enrichmentPath !== ":memory:") mkdirSync(dirname(options.enrichmentPath), { recursive: true });
    this.db = new Database(options.enrichmentPath ?? ":memory:", { create: true });
    this.db.exec(`PRAGMA busy_timeout=1000;
      CREATE TABLE IF NOT EXISTS enrichment (
        entity TEXT NOT NULL, id INTEGER NOT NULL, payload TEXT NOT NULL, fetched_at INTEGER NOT NULL,
        PRIMARY KEY(entity,id));
      CREATE TABLE IF NOT EXISTS ccb_character_enrichment (
        id INTEGER PRIMARY KEY, schema_version INTEGER NOT NULL, payload TEXT NOT NULL, fetched_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS ccb_directories (
        id INTEGER PRIMARY KEY, payload TEXT NOT NULL, imported_at INTEGER NOT NULL);`);
    this.now = options.now ?? Date.now;
    this.fetcher = options.fetcher ?? fetch;
    this.apiBase = (options.apiBase ?? "").replace(/\/+$/, "");
    this.imageBase = (options.imageBase ?? "").replace(/\/+$/, "");
  }

  readCharacter(id: number): CCBCharacterSupplement {
    const row = this.db.query<{ payload: string }, [number]>("SELECT payload FROM ccb_character_enrichment WHERE id=? AND schema_version=1").get(id);
    return row ? JSON.parse(row.payload) as CCBCharacterSupplement : {};
  }

  readImage(id: number, entity: ImageEntity = "character"): string | undefined {
    const row = this.db.query<{ payload: string }, [string, number]>("SELECT payload FROM enrichment WHERE entity=? AND id=?").get(entity, id);
    if (!row) return undefined;
    return rewriteBangumiImageUrl((JSON.parse(row.payload) as { image?: string }).image, this.imageBase);
  }

  resolveCharacterImage(id: number): Promise<string | undefined> {
    return this.resolveImage("character", id, () => this.loadCharacter(id));
  }

  /** 作品封面：与猜歌的 `LocalBangumiProvider` 共用回填表的 `subject` 实体，同样只存上游原始地址。 */
  resolveSubjectImage(id: number): Promise<string | undefined> {
    return this.resolveImage("subject", id, () => this.loadSubject(id));
  }

  private resolveImage(entity: ImageEntity, id: number, load: () => Promise<string | undefined>): Promise<string | undefined> {
    if (!Number.isSafeInteger(id) || id <= 0 || this.closed) return Promise.resolve(undefined);
    const persisted = this.readImage(id, entity);
    if (persisted) return Promise.resolve(persisted);
    const key = `${entity}:${id}`;
    if (!this.apiBase || (this.misses.get(key) ?? 0) > this.now()) return Promise.resolve(undefined);
    const running = this.inFlight.get(key);
    if (running) return running;
    const request = load().finally(() => this.inFlight.delete(key));
    this.inFlight.set(key, request);
    return request;
  }

  /** 上游 404 记作缺图（短期负缓存）；其余失败原样抛出，不固化。 */
  private async fetchEntity(entity: ImageEntity, id: number): Promise<unknown> {
    try {
      return await this.request(`/v0/${entity === "character" ? "characters" : "subjects"}/${id}`);
    } catch (error) {
      if (!(error instanceof AppError) || error.code !== "CCB_DATA_NOT_FOUND") throw error;
      this.misses.set(`${entity}:${id}`, this.now() + MISS_TTL_MS);
      return undefined;
    }
  }

  private async loadSubject(id: number): Promise<string | undefined> {
    const raw = await this.fetchEntity("subject", id);
    if (raw === undefined) return undefined;
    if (!Value.Check(SubjectResponse, raw)) throw new AppError("CCB_DATA_INVALID", "作品资料格式无效");
    const image = pickImage(raw.images);
    if (!image) {
      this.misses.set(`subject:${id}`, this.now() + MISS_TTL_MS);
      return undefined;
    }
    this.db.query("INSERT INTO enrichment VALUES ('subject',?,?,?) ON CONFLICT(entity,id) DO UPDATE SET payload=excluded.payload,fetched_at=excluded.fetched_at").run(id, JSON.stringify({ image }), this.now());
    return rewriteBangumiImageUrl(image, this.imageBase);
  }

  private async loadCharacter(id: number): Promise<string | undefined> {
    const raw = await this.fetchEntity("character", id);
    if (raw === undefined) return undefined;
    if (!Value.Check(CharacterResponse, raw)) throw new AppError("CCB_DATA_INVALID", "角色补充资料格式无效");
    const next: CCBCharacterSupplement = { ...this.readCharacter(id) };
    if (raw.name?.trim()) next.name = raw.name.trim();
    if (raw.summary?.trim()) next.summary = raw.summary;
    if (raw.gender === "male" || raw.gender === "female") next.gender = raw.gender;
    if (raw.stat?.collects !== undefined && raw.stat.comments !== undefined) next.popularity = Math.max(0, raw.stat.collects + raw.stat.comments);
    for (const entry of raw.infobox ?? []) {
      if (entry.key === "简体中文名" && typeof entry.value === "string" && entry.value.trim()) next.nameCn = entry.value.trim();
      if (entry.key === "别名" && Array.isArray(entry.value)) {
        const aliases = entry.value.flatMap((value: unknown) => {
          if (typeof value === "string") return value.trim() ? [value.trim()] : [];
          if (value && typeof value === "object" && "v" in value && typeof value.v === "string") return value.v.trim() ? [value.v.trim()] : [];
          return [];
        });
        if (aliases.length) next.aliases = [...new Set(aliases)];
      }
    }
    const image = pickImage(raw.images);
    this.db.transaction(() => {
      if (Object.keys(next).length) this.db.query("INSERT INTO ccb_character_enrichment VALUES (?,1,?,?) ON CONFLICT(id) DO UPDATE SET payload=excluded.payload,schema_version=1,fetched_at=excluded.fetched_at").run(id, JSON.stringify(next), this.now());
      if (image) this.db.query("INSERT INTO enrichment VALUES ('character',?,?,?) ON CONFLICT(entity,id) DO UPDATE SET payload=excluded.payload,fetched_at=excluded.fetched_at").run(id, JSON.stringify({ image }), this.now());
    })();
    if (!image) this.misses.set(`character:${id}`, this.now() + MISS_TTL_MS);
    return image ? rewriteBangumiImageUrl(image, this.imageBase) : undefined;
  }

  async fetchDirectory(indexId: number): Promise<number[]> {
    if (!this.apiBase) throw new AppError("CCB_IMPORT_UNAVAILABLE", "未配置目录导入服务");
    const ids = new Set<number>();
    for (let offset = 0; offset < 1000;) {
      const raw = await this.request(`/v0/indices/${indexId}/subjects?limit=100&offset=${offset}`);
      if (!Value.Check(DirectoryPage, raw)) throw new AppError("CCB_DATA_INVALID", "目录数据格式无效");
      if (raw.total > 1000) throw new AppError("CCB_DIRECTORY_TOO_LARGE", "目录最多支持一千部作品，请拆分目录");
      if (offset + raw.data.length > raw.total) throw new AppError("CCB_DATA_INVALID", "目录分页数量无效");
      for (const item of raw.data) ids.add(item.id);
      if (offset + raw.data.length >= raw.total) return [...ids];
      if (!raw.data.length) throw new AppError("CCB_DATA_INVALID", "目录分页数据不完整");
      offset += raw.data.length;
    }
    return [...ids];
  }

  getDirectory(id: number): CCBDirectoryResult | undefined {
    const row = this.db.query<{ payload: string }, [number]>("SELECT payload FROM ccb_directories WHERE id=?").get(id);
    return row ? JSON.parse(row.payload) as CCBDirectoryResult : undefined;
  }

  saveDirectory(result: CCBDirectoryResult): void {
    this.db.query("INSERT INTO ccb_directories VALUES (?,?,?) ON CONFLICT(id) DO UPDATE SET payload=excluded.payload,imported_at=excluded.imported_at").run(result.id, JSON.stringify(result), result.importedAt);
  }

  private async request(path: string): Promise<unknown> {
    if (this.closed) throw new AppError("CCB_DATA_UNAVAILABLE", "角色资料服务已关闭");
    if (this.queue.size >= 6 || this.cooldownUntil > this.now()) throw new AppError("BANGUMI_RATE_LIMITED", "资料请求过多，请稍后重试");
    return this.queue.add(async () => {
      if (this.cooldownUntil > this.now()) throw new AppError("BANGUMI_RATE_LIMITED", "资料请求过多，请稍后重试");
      let response: Response;
      try {
        response = await this.fetcher(`${this.apiBase}${path}`, { headers: { Accept: "application/json", "User-Agent": "BakaGame/1.0" }, signal: AbortSignal.timeout(5000) });
      } catch {
        throw new AppError("CCB_UPSTREAM_UNAVAILABLE", "暂时无法连接 Bangumi 资料服务");
      }
      if (response.status === 429) {
        this.cooldownUntil = this.now() + 5000;
        throw new AppError("BANGUMI_RATE_LIMITED", "资料请求过多，请稍后重试");
      }
      if (response.status === 404) throw new AppError("CCB_DATA_NOT_FOUND", "Bangumi 资料不存在");
      if (!response.ok) throw new AppError("CCB_IMPORT_FAILED", "读取 Bangumi 资料失败");
      try { return await response.json(); }
      catch { throw new AppError("CCB_DATA_INVALID", "Bangumi 资料格式无效"); }
    });
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    await Promise.allSettled(this.inFlight.values());
    await this.queue.onIdle();
    this.db.close();
  }
}
