import type { Database } from "bun:sqlite";
import type { BangumiSearchIndex } from "./BangumiSearchIndex";

/**
 * 新条目发现：补上「两份 dump 之间新出的作品」。
 *
 * 没有它，搜索永远搜不到新番 —— 数据集是构建产物，下次构建之前不会自己更新。
 *
 * 为什么不用 `sort: "date"`：官方搜索的 sort 白名单只有 `""` / `match` / `score` / `heat` / `rank`
 * （见 `internal/search/subject/handle.go`），传 date 直接 400。改用 `air_date` 过滤：
 * 只要「首播日期晚于上次同步日」的条目，结果集就是这段时间的新增，分页取全即可。
 * 搜索的 total 上限是 1000，一次窗口内足够。
 *
 * **裁剪规则同样适用**：既没有角色关联、也没有关联音乐的条目直接跳过 —— 与全量构建
 * 的判据保持一致，否则库里会慢慢长出一批永远用不到的条目。
 */

export interface DiscoveryOptions {
  db: Database;
  base: string;
  search?: BangumiSearchIndex;
  /** 上次同步到哪一天（YYYY-MM-DD）；缺省回看 30 天。 */
  since?: string;
  /** 单次最多带入多少条，防止上游异常时灌爆。 */
  limit?: number;
  fetcher?: typeof fetch;
  now?: () => number;
}

export interface DiscoveryResult {
  window: string;
  candidates: number;
  added: number;
  skipped: number;
  failed: number;
}

const DAY_MS = 24 * 60 * 60 * 1_000;
/** 作品类型：书籍 / 动画 / 音乐 / 游戏 / 三次元。 */
const ALL_TYPES = [1, 2, 3, 4, 6];

/** `/v0/subjects/{id}` 里本项目用得到的字段。 */
interface ApiSubject {
  id?: number;
  type?: number;
  name?: string;
  name_cn?: string;
  date?: string;
  infobox?: string;
  summary?: string;
  nsfw?: boolean;
  tags?: Array<{ name?: string; count?: number }>;
  meta_tags?: string[];
  images?: { large?: string };
  rating?: { score?: number; total?: number; rank?: number };
  collection?: Record<string, number>;
}

interface ApiCharacter {
  id?: number;
  role?: number;
  /** 关联类型（1 主角 / 2 配角…），角色列表接口会带。 */
  type?: number;
  name?: string;
  name_cn?: string;
  gender?: string;
  summary?: string;
  comments?: number;
  collects?: number;
}

const ymd = (time: number) => new Date(time).toISOString().slice(0, 10);

export async function discoverNewSubjects(options: DiscoveryOptions): Promise<DiscoveryResult> {
  const fetcher = options.fetcher ?? fetch;
  const now = options.now ?? Date.now;
  const since = options.since ?? ymd(now() - 30 * DAY_MS);
  const limit = options.limit ?? 1000;

  const candidates = await searchSince(fetcher, options.base, since, limit);
  const result: DiscoveryResult = { window: since, candidates: candidates.length, added: 0, skipped: 0, failed: 0 };
  if (!candidates.length) return result;

  const known = new Set<number>(
    (options.db.query("SELECT id FROM subjects").all() as Array<{ id: number }>).map((row) => Number(row.id)),
  );

  for (const subjectId of candidates) {
    // 已经在库里的不动：它们的评分/热度由日常刷新负责，这里只补「新」的。
    if (known.has(subjectId)) { result.skipped += 1; continue; }
    try {
      const added = await importSubject(fetcher, options.base, options.db, options.search, subjectId);
      if (added) result.added += 1; else result.skipped += 1;
    } catch {
      result.failed += 1;
    }
  }
  return result;
}

/** 按首播日期过滤 + 分页取全（total 上限 1000，够一个同步窗口用）。 */
async function searchSince(fetcher: typeof fetch, base: string, since: string, limit: number): Promise<number[]> {
  const ids: number[] = [];
  for (let offset = 0; offset < limit; offset += 100) {
    const response = await fetcher(`${base}/v0/search/subjects`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json", "User-Agent": "BakaGame/1.0" },
      body: JSON.stringify({ keyword: "", filter: { air_date: [`>=${since}`], type: ALL_TYPES }, sort: "heat", limit: 100, offset }),
    });
    if (!response.ok) break;
    const body = await response.json() as { data?: Array<{ id: number }> };
    const page = (body.data ?? []).map((item) => Number(item.id));
    ids.push(...page);
    if (page.length < 100) break;
  }
  return ids;
}

/**
 * 导入单个作品：拉详情 → 判裁剪 → 写作品与它的角色/关联 → 更新索引。
 * 返回是否真的入库（被裁掉的返回 false）。
 */
async function importSubject(
  fetcher: typeof fetch, base: string, db: Database, search: BangumiSearchIndex | undefined, subjectId: number,
): Promise<boolean> {
  const [subject, characters, related] = await Promise.all([
    getJson<ApiSubject>(fetcher, `${base}/v0/subjects/${subjectId}`),
    getJson<ApiCharacter[]>(fetcher, `${base}/v0/subjects/${subjectId}/characters`),
    getJson<Array<{ id?: number; type?: number }>>(fetcher, `${base}/v0/subjects/${subjectId}/subjects`),
  ]);
  if (!subject) return false;
  // 合规：匿名拿到的条目 nsfw 恒为 false，这里再挡一道，防止上游行为变化。
  if (subject.nsfw) return false;

  const characterRows = Array.isArray(characters) ? characters : [];
  const relationRows = Array.isArray(related) ? related : [];
  const musicIds = relationRows.filter((row) => Number(row.type) === 3).map((row) => Number(row.id));
  // 裁剪：没角色也没音乐的直接丢，与全量构建同一条判据。
  if (!characterRows.length && !musicIds.length) return false;

  const tags = subject.tags ?? [];
  const tagNames = tags.map((tag) => String(tag.name)).filter(Boolean);
  const rawTags = Object.fromEntries(tags.filter((tag) => tag.name).map((tag) => [String(tag.name), Number(tag.count ?? 0)]));
  const rating = subject.rating ?? {};
  const collection = subject.collection ?? {};
  const heat = Object.values(collection).reduce<number>((sum, value) => sum + Number(value ?? 0), 0);
  const aliases = [String(subject.name_cn ?? "")].filter(Boolean);

  db.query("INSERT OR REPLACE INTO subjects VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)").run(
    subjectId, Number(subject.type ?? 0), String(subject.name ?? ""), String(subject.name_cn ?? ""),
    JSON.stringify(aliases), String(subject.infobox ?? ""), String(subject.summary ?? ""), String(subject.date ?? ""),
    0, JSON.stringify(tagNames), JSON.stringify(rawTags), JSON.stringify(subject.meta_tags ?? []),
    Number(rating.score ?? 0), Number(rating.total ?? 0), heat, Number(rating.rank ?? 0),
    String((subject.images ?? {}).large ?? ""),
  );

  // 角色：只补库中没有的，已有角色不动（它们的详情由各自的作品覆盖）。
  for (const row of characterRows) {
    const characterId = Number(row.id);
    if (!Number.isInteger(characterId) || characterId <= 0) continue;
    const exists = db.query("SELECT 1 FROM characters WHERE id=?").get(characterId);
    if (!exists) {
      const detail = await getJson<ApiCharacter>(fetcher, `${base}/v0/characters/${characterId}`);
      if (!detail) continue;
      db.query("INSERT OR REPLACE INTO characters VALUES (?,?,?,?,?,?,?,?,?)").run(
        characterId, Number(detail.role ?? 0), String(detail.name ?? ""), String(detail.name_cn ?? ""),
        String(detail.gender ?? ""), JSON.stringify([]), String(detail.summary ?? ""),
        Number(detail.comments ?? 0), Number(detail.collects ?? 0),
      );
      search?.updateCharacter({
        id: characterId, name: String(detail.name ?? ""),
        aliases: [String(detail.name_cn ?? "")].filter(Boolean),
        comment: Number(detail.comments ?? 0), collect: Number(detail.collects ?? 0),
      }).catch(() => { /* 索引失败不影响数据落库，下轮重建会补上 */ });
    }
    db.query("INSERT OR IGNORE INTO character_subject_relations VALUES (?,?,?,?)")
      .run(characterId, subjectId, Number(row.type ?? 0), 0);
  }

  // 关联作品：音乐条目要连曲目一起带出来（猜歌的出题素材）。
  for (const row of relationRows) {
    const relatedId = Number(row.id);
    if (Number(row.type) === 3) {
      const music = await getJson<ApiSubject>(fetcher, `${base}/v0/subjects/${relatedId}`);
      const title = String(music?.name_cn || music?.name || "");
      if (title) {
        db.query("INSERT OR IGNORE INTO subject_music_relations VALUES (?,?,?,?,?,?,?)")
          .run(subjectId, relatedId, 0, 0, title, null, "theme");
      }
    }
  }

  search?.updateSubject({
    id: subjectId, name: String(subject.name ?? ""), aliases,
    tag: tagNames, meta_tag: (subject.meta_tags ?? []).map(String),
    date: Number(String(subject.date ?? "").replace(/-/g, "")) || 0,
    score: Number(rating.score ?? 0), rating_count: Number(rating.total ?? 0),
    heat, rank: Number(rating.rank ?? 0), type: Number(subject.type ?? 0),
  }).catch(() => {});
  return true;
}

async function getJson<T>(fetcher: typeof fetch, url: string): Promise<T | null> {
  try {
    const response = await fetcher(url, { headers: { Accept: "application/json", "User-Agent": "BakaGame/1.0" } });
    if (!response.ok) return null;
    return await response.json() as T;
  } catch {
    return null;
  }
}
