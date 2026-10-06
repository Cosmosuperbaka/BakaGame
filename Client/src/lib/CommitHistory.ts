/**
 * 提交历史的取数与归一化。
 *
 * 数据有两个来源，但对外只有一份契约：
 *   1. 构建期优先调 GitHub REST API——构建容器是浅克隆（depth=1），本地 git 日志只有 HEAD 一条；
 *   2. 本地开发与 API 不可用时读本地 git 日志。
 * 两条路径都先落成 `RawCommit`，再由 `normalizeCommitEntries` 统一收口，
 * 因此 `virtual:commit-history` 的形状、`src/vite-env.d.ts` 的声明，
 * 以及三个消费方（页脚时间线、版本提示、Sentry release）都不必分叉。
 *
 * 本模块必须保持零依赖、不碰浏览器与 Node API：`vite.config.ts` 在 Node 环境下构建期直接调它。
 */

/** 展示用条目。字段名即虚拟模块契约，改动要同步 `src/vite-env.d.ts`。 */
export interface CommitEntry {
  hash: string;
  message: string;
  date: string;
  author: string;
}

/** 虚拟模块的完整形状，与 `src/vite-env.d.ts` 里 `virtual:commit-history` 的声明一一对应。 */
export interface CommitHistory {
  generatedAt: string;
  currentCommit: string;
  commits: CommitEntry[];
}

/** 一次取多少条。面板高度固定，取再多也只是让人多滚几屏。 */
export const COMMIT_HISTORY_LIMIT = 30;

/** 短哈希长度，与页脚版本号、`meta[name=bakagame-build]` 保持一致。 */
export const SHORT_HASH_LENGTH = 7;

/** 取不到作者名时的占位，不省略整条：提交信息本身仍有价值。 */
const UNKNOWN_AUTHOR = "未知作者";

/** 两条取数路径的共同中间形状，字段一律按未知类型收，校验后才是 `CommitEntry`。 */
interface RawCommit {
  hash?: unknown;
  message?: unknown;
  date?: unknown;
  author?: unknown;
}

/** GitHub `/commits` 响应里我们认得的字段；其余字段不进产物。 */
interface GitHubCommitResponse {
  sha?: unknown;
  commit?: {
    message?: unknown;
    author?: { name?: unknown; date?: unknown } | null;
  } | null;
}

const REPOSITORY_PATTERN =
  /^https:\/\/github\.com\/([A-Za-z0-9._-]+)\/([A-Za-z0-9._-]+?)(?:\.git)?\/?$/;

/**
 * 从仓库地址解析出 `owner/repo`。
 * 只认 github.com 的 https 地址，解析不出来返回 null，调用方据此跳过一次网络请求。
 */
export function repositorySlug(repositoryUrl: string): string | null {
  const matched = repositoryUrl.trim().match(REPOSITORY_PATTERN);
  return matched ? `${matched[1]}/${matched[2]}` : null;
}

/**
 * 拼接提交列表接口地址。
 *
 * 用构建提交作 `sha` 起点而不是裸查 `/commits`：列表第一条才与页脚版本号里的短哈希、
 * `meta[name=bakagame-build]` 是同一个提交；否则构建之后 main 再前进一次，三处就会各说一套。
 */
export function commitsApiUrl(
  repositoryUrl: string,
  sha: string,
  limit: number = COMMIT_HISTORY_LIMIT,
): string | null {
  const slug = repositorySlug(repositoryUrl);
  const revision = sha.trim();
  if (!slug || !revision) return null;

  const url = new URL(`https://api.github.com/repos/${slug}/commits`);
  url.searchParams.set("sha", revision);
  url.searchParams.set("per_page", String(limit));
  return url.toString();
}

/** GitHub 的 message 是「主题行 + 空行 + 正文」，时间线只展示主题行。 */
function subjectLine(value: unknown): string {
  if (typeof value !== "string") return "";
  return (value.split("\n")[0] ?? "").trim();
}

/**
 * 归一化时间。git 给的是带本地时区的 iso-strict，GitHub 给的是 UTC，
 * 两者先统一成 ISO UTC 再进产物，前端算相对时间就不会踩时区。
 */
function normalizeDate(value: unknown): string | null {
  if (typeof value !== "string") return null;

  const raw = value.trim();
  if (!raw) return null;

  const parsed = new Date(/^\d{4}-\d{2}-\d{2}$/.test(raw) ? `${raw}T00:00:00Z` : raw);
  return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString();
}

/**
 * 把两条路径的原始条目收口成展示条目。
 *
 * 缺哈希、缺主题行或时间不可解析的条目直接丢弃：时间线里一条信息残缺的提交，
 * 比少一条更让人困惑。条数按 `limit` 截断。
 */
export function normalizeCommitEntries(
  raw: unknown,
  limit: number = COMMIT_HISTORY_LIMIT,
): CommitEntry[] {
  if (!Array.isArray(raw)) return [];

  const entries: CommitEntry[] = [];
  for (const item of raw) {
    if (entries.length >= limit) break;
    if (!item || typeof item !== "object") continue;

    const record = item as RawCommit;
    const hash = typeof record.hash === "string" ? record.hash.trim() : "";
    const message = subjectLine(record.message);
    const date = normalizeDate(record.date);
    if (hash.length < SHORT_HASH_LENGTH || !message || !date) continue;

    const author = typeof record.author === "string" ? record.author.trim() : "";
    entries.push({
      hash: hash.slice(0, SHORT_HASH_LENGTH),
      message,
      date,
      author: author || UNKNOWN_AUTHOR,
    });
  }

  return entries;
}

/**
 * 把 GitHub 响应映射成展示条目。
 *
 * 白名单式取值：作者邮箱等未列出的字段一律不进产物——构建期数据会随 JS 发给每个访客。
 */
export function mapGitHubCommits(
  payload: unknown,
  limit: number = COMMIT_HISTORY_LIMIT,
): CommitEntry[] {
  if (!Array.isArray(payload)) return [];

  const raw: RawCommit[] = payload.map((item) => {
    const record = (item && typeof item === "object" ? item : {}) as GitHubCommitResponse;
    const author = record.commit?.author ?? null;

    return {
      hash: record.sha,
      message: record.commit?.message,
      date: author?.date,
      author: author?.name,
    };
  });

  return normalizeCommitEntries(raw, limit);
}
