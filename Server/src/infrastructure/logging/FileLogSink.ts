import {
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  statSync,
  writeSync,
} from "node:fs";
import { join } from "node:path";

import { formatOtelLogLine, type LogSink, type OtelLogRecord, type OtelResource } from "./OtelLog";

/** 单个分段文件的字节上限：一条记录不会被切开，所以实际大小可能超出一条的长度。 */
const DEFAULT_MAX_FILE_BYTES = 64 * 1024 * 1024;
/** 每个 UTC 日最多写多少个分段：与单文件上限相乘就是单日磁盘占用的硬上限。 */
const DEFAULT_MAX_SEGMENTS_PER_DAY = 16;
/** 低级别记录的合并写周期：告警及以上不等它，立即落盘。 */
const DEFAULT_FLUSH_INTERVAL_MS = 200;
/** 缓冲累计到这个量就不等周期、当场合并写，避免突发日志把内存撑大。 */
const MAX_PENDING_BYTES = 256 * 1024;
/** OTel 严重级别数字：告警级起（13）必须立即落盘，这类记录是事后排障最需要的，且量级很小。 */
const IMMEDIATE_SEVERITY = 13;

export interface FileLogSinkOptions {
  directory: string;
  environment: string;
  resource: OtelResource;
  scopeName?: string;
  onError?: (error: unknown) => void;
  maxFileBytes?: number;
  maxSegmentsPerDay?: number;
  flushIntervalMs?: number;
  /** 当日分段数封顶、开始丢弃记录时回调一次（每个 UTC 日至多一次），附带当次丢弃数。 */
  onLimit?: (info: { date: string; dropped: number }) => void;
}

/** 环境名只用于文件名，先归一成安全片段，避免路径分隔符与任意字符进入文件系统。 */
export const environmentSlug = (environment: string): string => {
  const slug = environment
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 32);
  return slug || "unknown";
};

const dateKey = (record: OtelLogRecord): string => {
  const milliseconds = Number(BigInt(record.timeUnixNano) / 1_000_000n);
  return new Date(milliseconds).toISOString().slice(0, 10);
};

interface PendingLine {
  date: string;
  text: string;
}

/**
 * 本地 OTel JSONL 文件出口。
 *
 * 写入按「告警及以上立即、其余合并」两档：告警与错误记录当场同步落盘（进程被强杀前最后一条错误必须在盘上，
 * 停机看门狗的强制终止日志也走这一档），信息与调试记录进内存缓冲，按短周期或体量阈值合并成一次写入，
 * 不再每条日志阻塞一次事件循环。`flush`/`close` 同步排空，停机流程据此保证不丢；
 * 低级别记录在强杀时最多丢一个合并窗口。
 *
 * 一行一条 OTLP/JSON，文件名按部署环境与 UTC 日区分，同一台机器同时跑开发与生产也不会混进同一个文件。
 * 单文件有字节上限，超限滚到下一个分段；每日分段数也有上限，封顶后当日记录直接丢弃并提示一次，
 * 日志洪水因此最多占满一个确定的磁盘配额，而不是无限增长。保留清理仍由部署侧负责。
 */
export class FileLogSink implements LogSink {
  private readonly directory: string;
  private readonly environment: string;
  private readonly resource: OtelResource;
  private readonly scopeName?: string;
  private readonly onError?: (error: unknown) => void;
  private readonly onLimit?: (info: { date: string; dropped: number }) => void;
  private readonly maxFileBytes: number;
  private readonly maxSegmentsPerDay: number;
  private readonly flushIntervalMs: number;
  private fd?: number;
  private currentDate?: string;
  private currentSegment = 0;
  private currentSize = 0;
  private disabled = false;
  private pending: PendingLine[] = [];
  private pendingBytes = 0;
  private timer: ReturnType<typeof setTimeout> | undefined;
  /** 已封顶的 UTC 日：值为封顶后丢弃的条数。 */
  private readonly capped = new Map<string, number>();

  constructor(options: FileLogSinkOptions) {
    this.directory = options.directory;
    this.environment = environmentSlug(options.environment);
    this.resource = options.resource;
    this.scopeName = options.scopeName;
    this.onError = options.onError;
    this.onLimit = options.onLimit;
    this.maxFileBytes = Math.max(1, options.maxFileBytes ?? DEFAULT_MAX_FILE_BYTES);
    this.maxSegmentsPerDay = Math.max(1, options.maxSegmentsPerDay ?? DEFAULT_MAX_SEGMENTS_PER_DAY);
    this.flushIntervalMs = Math.max(1, options.flushIntervalMs ?? DEFAULT_FLUSH_INTERVAL_MS);
  }

  write(record: OtelLogRecord): void {
    if (this.disabled) return;
    try {
      const text = `${formatOtelLogLine(record, this.resource, this.scopeName)}\n`;
      this.pending.push({ date: dateKey(record), text });
      this.pendingBytes += text.length;
      if (record.severityNumber >= IMMEDIATE_SEVERITY || this.pendingBytes >= MAX_PENDING_BYTES) {
        this.drain();
      } else this.schedule();
    } catch (error) {
      this.disable(error);
    }
  }

  flush(): void {
    if (this.disabled) return;
    this.drain();
    if (this.fd === undefined) return;
    try {
      fsyncSync(this.fd);
    } catch (error) {
      this.disable(error);
    }
  }

  close(): void {
    this.cancelTimer();
    if (!this.disabled) this.drain();
    this.closeFile();
  }

  private schedule(): void {
    if (this.timer) return;
    this.timer = setTimeout(() => {
      this.timer = undefined;
      this.drain();
    }, this.flushIntervalMs);
    // 缓冲里的记录不该拖住进程退出：正常退出走 flush/close，不靠这个定时器。
    this.timer.unref?.();
  }

  private cancelTimer(): void {
    if (!this.timer) return;
    clearTimeout(this.timer);
    this.timer = undefined;
  }

  /** 把缓冲按日期分组、各合成一次写入；写失败只停用本出口。 */
  private drain(): void {
    this.cancelTimer();
    if (this.pending.length === 0) return;
    const lines = this.pending;
    this.pending = [];
    this.pendingBytes = 0;
    if (this.disabled) return;
    try {
      let text = "";
      let bytes = 0;
      let count = 0;
      let date = lines[0]!.date;
      const commit = (): void => {
        if (count > 0) this.writeChunk(date, text, bytes, count);
        text = "";
        bytes = 0;
        count = 0;
      };
      for (const line of lines) {
        const size = Buffer.byteLength(line.text, "utf8");
        // 换日或单块将超过分段上限就先提交：合并写也不能把一个分段一次写爆。
        if (count > 0 && (line.date !== date || bytes + size > this.maxFileBytes)) commit();
        date = line.date;
        text += line.text;
        bytes += size;
        count += 1;
      }
      commit();
    } catch (error) {
      this.disable(error);
    }
  }

  private writeChunk(date: string, text: string, bytes: number, count: number): void {
    if (this.capped.has(date)) {
      this.capped.set(date, this.capped.get(date)! + count);
      return;
    }
    const fd = this.openFor(date, bytes);
    if (fd === undefined) {
      this.capped.set(date, count);
      this.onLimit?.({ date, dropped: count });
      return;
    }
    const buffer = Buffer.from(text, "utf8");
    let offset = 0;
    while (offset < buffer.length) offset += writeSync(fd, buffer, offset);
    this.currentSize += buffer.length;
  }

  private segmentPath(date: string, segment: number): string {
    const suffix = segment === 0 ? "" : `.${segment}`;
    return join(this.directory, `server-${this.environment}-${date}${suffix}.log`);
  }

  /**
   * 取得当日可写的分段：沿用当前分段，放不下就滚到下一个；重启后从头找第一个还有余量的分段。
   * 分段数用尽返回 undefined，由调用方按封顶处理。
   */
  private openFor(date: string, incoming: number): number | undefined {
    if (this.fd !== undefined && this.currentDate === date) {
      // 空分段允许超大块写入（单次合并写可能就大于上限），否则永远滚不出去。
      if (this.currentSize === 0 || this.currentSize + incoming <= this.maxFileBytes)
        return this.fd;
      return this.openSegment(date, this.currentSegment + 1, incoming);
    }
    this.closeFile();
    mkdirSync(this.directory, { recursive: true });
    return this.openSegment(date, 0, incoming);
  }

  private openSegment(date: string, from: number, incoming: number): number | undefined {
    this.closeFile();
    mkdirSync(this.directory, { recursive: true });
    for (let segment = from; segment < this.maxSegmentsPerDay; segment += 1) {
      const path = this.segmentPath(date, segment);
      const size = existsSync(path) ? statSync(path).size : 0;
      if (size > 0 && size + incoming > this.maxFileBytes) continue;
      this.fd = openSync(path, "a");
      this.currentDate = date;
      this.currentSegment = segment;
      this.currentSize = size;
      return this.fd;
    }
    return undefined;
  }

  private closeFile(): void {
    if (this.fd === undefined) return;
    try {
      fsyncSync(this.fd);
    } catch {
      // 关文件前的最后一次刷盘失败不改变已写入内容；关闭仍要继续。
    }
    try {
      closeSync(this.fd);
    } catch {
      // 关闭失败只在进程退出路径上出现，不影响其它出口。
    }
    this.fd = undefined;
    this.currentDate = undefined;
  }

  private disable(error: unknown): void {
    if (this.disabled) return;
    this.disabled = true;
    this.cancelTimer();
    this.pending = [];
    this.closeFile();
    this.onError?.(error);
  }
}
