import { z } from "zod";

import { AppError } from "../domain/Errors";
import type { SentryOverview } from "../shared/ApiContract";
import type { EventLogger } from "./EventLogger";

export interface SentryApiConfig {
  /** 区域 API 基址，如 `https://us.sentry.io`。 */
  baseUrl: string;
  organizationId: string;
  /** 前后端各一个项目：取隧道白名单（已含服务端 DSN 项目）。 */
  projectIds: string[];
  token: string;
}

/**
 * 由 DSN 推出组织与区域：SaaS DSN 形如 `o<组织号>.ingest[.<区域>].sentry.io/<项目号>`。
 * 自建 Sentry 的 DSN 不含这些信息，直接报配置错误而不是猜一个地址。
 */
export const deriveSentryApiConfig = (
  dsn: string,
  projectIds: string[],
  token: string
): SentryApiConfig => {
  const host = new URL(dsn).hostname;
  const match = /^o(\d+)\.ingest(?:\.([a-z]{2}))?\.sentry\.io$/.exec(host);
  if (!match)
    throw new AppError(
      "CONFIG_ERROR",
      "SENTRY_API_TOKEN 只支持 sentry.io 的 DSN（需从中读出组织与区域）"
    );
  const region = match[2];
  return {
    baseUrl: region ? `https://${region}.sentry.io` : "https://sentry.io",
    organizationId: match[1]!,
    projectIds,
    token,
  };
};

const CACHE_MS = 60 * 1000;
const TIMEOUT_MS = 8000;

const issueSchema = z.object({
  id: z.string(),
  shortId: z.string(),
  title: z.string(),
  culprit: z.string().nullish(),
  level: z.string(),
  count: z.coerce.number(),
  userCount: z.coerce.number(),
  lastSeen: z.string(),
  permalink: z.string().nullish(),
  project: z.object({ slug: z.string() }).nullish(),
});
const tableSchema = z.object({ data: z.array(z.record(z.string(), z.unknown())) });
const numberOrNull = (value: unknown) =>
  typeof value === "number" && Number.isFinite(value) ? value : null;

/** 后台概览用的 Sentry 只读查询：三个查询各自容错，结果缓存 60 秒，避免刷新页面打满 API 限额。 */
export class SentryApiClient {
  private cache: { at: number; value: SentryOverview } | undefined;
  private loading: Promise<SentryOverview> | undefined;

  constructor(
    private readonly config: SentryApiConfig,
    private readonly logger: EventLogger,
    private readonly fetcher: typeof fetch = fetch,
    private readonly now: () => number = Date.now
  ) {}

  async overview(): Promise<SentryOverview> {
    if (this.cache && this.now() - this.cache.at < CACHE_MS) return this.cache.value;
    this.loading ??= this.load().finally(() => {
      this.loading = undefined;
    });
    return this.loading;
  }

  private async load(): Promise<SentryOverview> {
    const warnings: string[] = [];
    const attempt = async <T>(label: string, run: () => Promise<T>): Promise<T | null> => {
      try {
        return await run();
      } catch (error) {
        const reason = error instanceof SentryHttpError ? `HTTP ${error.status}` : "请求失败";
        warnings.push(`${label}：${reason}`);
        this.logger.warn("Sentry 概览查询失败", {
          query: label,
          reason,
          error: error instanceof SentryHttpError ? undefined : String(error),
        });
        return null;
      }
    };
    const [issues, errors, transactions] = await Promise.all([
      attempt("问题列表", () => this.issues()),
      attempt("错误数", () => this.errorCount()),
      attempt("性能", () => this.transactions()),
    ]);
    const value: SentryOverview = {
      configured: true,
      errors24h: errors,
      unresolvedIssues: issues?.total ?? null,
      issues: issues?.items ?? [],
      transactions,
      warnings,
      fetchedAt: new Date(this.now()).toISOString(),
    };
    this.cache = { at: this.now(), value };
    return value;
  }

  private async request(path: string, params: URLSearchParams): Promise<Response> {
    const url = new URL(
      `/api/0/organizations/${this.config.organizationId}/${path}?${params.toString()}`,
      this.config.baseUrl
    );
    for (const id of this.config.projectIds) url.searchParams.append("project", id);
    const response = await this.fetcher(url, {
      headers: { authorization: `Bearer ${this.config.token}` },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (!response.ok) throw new SentryHttpError(response.status);
    return response;
  }

  private async table(
    params: Record<string, string>,
    fields: string[]
  ): Promise<Array<Record<string, unknown>>> {
    const query = new URLSearchParams(params);
    for (const field of fields) query.append("field", field);
    const response = await this.request("events/", query);
    return tableSchema.parse(await response.json()).data;
  }

  private async issues() {
    const response = await this.request(
      "issues/",
      new URLSearchParams({
        query: "is:unresolved",
        statsPeriod: "24h",
        sort: "freq",
        limit: "5",
      })
    );
    const items = z
      .array(issueSchema)
      .parse(await response.json())
      .map((issue) => ({
        id: issue.id,
        shortId: issue.shortId,
        title: issue.title,
        culprit: issue.culprit ?? null,
        level: issue.level,
        count: issue.count,
        userCount: issue.userCount,
        lastSeen: issue.lastSeen,
        permalink: issue.permalink ?? null,
        project: issue.project?.slug ?? null,
      }));
    const hits = Number(response.headers.get("x-hits"));
    return {
      items,
      total: Number.isFinite(hits) && response.headers.has("x-hits") ? hits : items.length,
    };
  }

  private async errorCount(): Promise<number> {
    const rows = await this.table({ dataset: "errors", statsPeriod: "24h" }, ["count()"]);
    return numberOrNull(rows[0]?.["count()"]) ?? 0;
  }

  private async transactions() {
    const rows = await this.table(
      {
        dataset: "spans",
        statsPeriod: "24h",
        query: "is_transaction:true",
        sort: "-count()",
        per_page: "8",
      },
      ["transaction", "project", "count()", "p75(span.duration)", "p95(span.duration)"]
    );
    return rows.map((row) => ({
      name: typeof row.transaction === "string" ? row.transaction : "",
      project: typeof row.project === "string" ? row.project : null,
      count: numberOrNull(row["count()"]) ?? 0,
      p75: numberOrNull(row["p75(span.duration)"]),
      p95: numberOrNull(row["p95(span.duration)"]),
    }));
  }
}

class SentryHttpError extends Error {
  constructor(readonly status: number) {
    super(`Sentry API ${status}`);
  }
}

/** 未配置令牌时后台展示的占位。 */
export const SENTRY_NOT_CONFIGURED: SentryOverview = {
  configured: false,
  errors24h: null,
  unresolvedIssues: null,
  issues: [],
  transactions: null,
  warnings: [],
  fetchedAt: null,
};
