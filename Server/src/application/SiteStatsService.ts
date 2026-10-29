import { createHmac, hkdfSync } from "node:crypto";

import { beijingDay } from "../domain/BeijingDay";
import type { EventLogger } from "../infrastructure/EventLogger";
import type {
  PageDelta,
  SiteStatsRepository,
  VisitorDelta,
} from "../infrastructure/db/SiteStatsRepository";

const FLUSH_INTERVAL_MS = 60 * 1000;
const PURGE_INTERVAL_MS = 6 * 60 * 60 * 1000;
const PURGE_BATCH = 500;
/** 访客行（含账号关联）保留 90 天；页面汇总不含个人数据，长期保留。 */
export const SITE_VISITOR_RETENTION_DAYS = 90;
/** 单个刷写窗口最多跟踪的新访客数：伪造访客 ID 刷量时保护进程内存，超出的访客只计页面浏览。 */
const MAX_PENDING_VISITORS = 5000;
const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * 页面只按板块统计：房间号、单人房等路径参数一律折叠，防止统计表按房号无限膨胀，
 * 也不把房号这类可定位到具体对局的信息落库。
 */
const SECTIONS = new Set(["whoisfaker", "songuessr", "cee", "admin"]);
export const normalizeVisitPath = (raw: string): string => {
  const segments = raw.split(/[?#]/)[0]!.toLowerCase().split("/").filter(Boolean);
  if (!segments.length) return "/";
  const [section, child] = segments;
  if (!section || !SECTIONS.has(section)) return "other";
  if (section === "admin") return "/admin";
  if (child === "room") return `/${section}/room`;
  if (section === "songuessr" && child === "solo") return "/songuessr/solo";
  return `/${section}`;
};

export interface SiteStatsServiceOptions {
  repository: SiteStatsRepository;
  /** 访客 ID 的摘要密钥来源（`BETTER_AUTH_SECRET`），经 HKDF 派生专用子密钥。 */
  secret: string;
  logger: EventLogger;
  now?: () => number;
}

/**
 * 站点访问统计：前端每次载入页面报一次，进程内聚合、每分钟刷写一次。
 *
 * 访客 ID 是浏览器本地随机值，落库前与「密钥 + 当天」做 HMAC：同一访客跨天不可关联，
 * 库里也还原不出浏览器侧的 ID。不记录 IP（理由同账号限流，见 Account §3）。
 */
export class SiteStatsService {
  private readonly now: () => number;
  private readonly key: Buffer;
  private visitors = new Map<string, VisitorDelta>();
  private pages = new Map<string, PageDelta>();
  private overflowWarned = false;
  private flushTimer: ReturnType<typeof setInterval> | undefined;
  private purgeTimer: ReturnType<typeof setInterval> | undefined;
  private flushing: Promise<void> | undefined;

  constructor(private readonly options: SiteStatsServiceOptions) {
    this.now = options.now ?? Date.now;
    this.key = Buffer.from(hkdfSync("sha256", options.secret, "bakagame", "site-visitor-hash", 32));
  }

  record(input: { visitorId: string; path: string; userId: string | null }): void {
    const day = beijingDay(this.now());
    const visitorHash = createHmac("sha256", this.key)
      .update(`${day}\n${input.visitorId}`)
      .digest("base64url")
      .slice(0, 32);
    const visitorKey = `${day}:${visitorHash}`;
    const visitor = this.visitors.get(visitorKey);
    if (visitor) {
      visitor.views += 1;
      visitor.userId = input.userId ?? visitor.userId;
    } else if (this.visitors.size < MAX_PENDING_VISITORS) {
      this.visitors.set(visitorKey, { day, visitorHash, userId: input.userId, views: 1 });
    } else if (!this.overflowWarned) {
      this.overflowWarned = true;
      this.options.logger.warn("访问统计窗口内新访客过多，超出部分只计页面浏览", {
        limit: MAX_PENDING_VISITORS,
      });
    }
    const path = normalizeVisitPath(input.path);
    const pageKey = `${day}:${path}`;
    const page = this.pages.get(pageKey);
    if (page) page.views += 1;
    else this.pages.set(pageKey, { day, path, views: 1 });
  }

  /** 把当前窗口写库；写库失败丢弃本窗口并告警（统计允许少量缺口，不为它积压内存）。 */
  async flush(): Promise<void> {
    if (this.flushing) await this.flushing;
    if (!this.visitors.size && !this.pages.size) return;
    const visitors = [...this.visitors.values()];
    const pages = [...this.pages.values()];
    this.visitors = new Map();
    this.pages = new Map();
    this.overflowWarned = false;
    this.flushing = this.options.repository
      .addVisits(visitors, pages)
      .catch((error: unknown) => {
        this.options.logger.warn("访问统计写入失败，本窗口已丢弃", {
          visitors: visitors.length,
          error: String(error),
        });
      })
      .finally(() => {
        this.flushing = undefined;
      });
    await this.flushing;
  }

  async purge(): Promise<number> {
    const beforeDay = beijingDay(this.now() - SITE_VISITOR_RETENTION_DAYS * DAY_MS);
    let removed = 0;
    try {
      for (;;) {
        const count = await this.options.repository.purgeVisitors(beforeDay, PURGE_BATCH);
        removed += count;
        if (count < PURGE_BATCH) break;
      }
    } catch (error) {
      this.options.logger.warn("访问统计清理失败", { error: String(error) });
    }
    return removed;
  }

  start(): void {
    if (this.flushTimer) return;
    this.flushTimer = setInterval(() => void this.flush(), FLUSH_INTERVAL_MS);
    this.flushTimer.unref?.();
    void this.purge();
    this.purgeTimer = setInterval(() => void this.purge(), PURGE_INTERVAL_MS);
    this.purgeTimer.unref?.();
  }

  /** 停止定时器并刷写最后一个窗口（进程退出前、关闭数据库之前调用）。 */
  async close(): Promise<void> {
    if (this.flushTimer) clearInterval(this.flushTimer);
    if (this.purgeTimer) clearInterval(this.purgeTimer);
    this.flushTimer = undefined;
    this.purgeTimer = undefined;
    await this.flush();
  }
}
