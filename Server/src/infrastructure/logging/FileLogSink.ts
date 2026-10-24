import { closeSync, fsyncSync, mkdirSync, openSync, writeSync } from "node:fs";
import { join } from "node:path";

import { formatOtelLogLine, type LogSink, type OtelLogRecord, type OtelResource } from "./OtelLog";

export interface FileLogSinkOptions {
  directory: string;
  environment: string;
  resource: OtelResource;
  scopeName?: string;
  onError?: (error: unknown) => void;
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

/**
 * 本地 OTel JSONL 文件出口。
 *
 * 用同步写入而不是内存缓冲：日志最需要存在的时刻恰好是进程被强杀之后，
 * 缓冲在这里会直接丢掉最后一段。一行一条 OTLP/JSON，文件名按部署环境区分，
 * 同一台机器上同时跑开发与生产也不会混进同一个文件。
 */
export class FileLogSink implements LogSink {
  private readonly directory: string;
  private readonly environment: string;
  private readonly resource: OtelResource;
  private readonly scopeName?: string;
  private readonly onError?: (error: unknown) => void;
  private fd?: number;
  private currentDate?: string;
  private disabled = false;

  constructor(options: FileLogSinkOptions) {
    this.directory = options.directory;
    this.environment = environmentSlug(options.environment);
    this.resource = options.resource;
    this.scopeName = options.scopeName;
    this.onError = options.onError;
  }

  write(record: OtelLogRecord): void {
    if (this.disabled) return;
    try {
      const line = `${formatOtelLogLine(record, this.resource, this.scopeName)}\n`;
      const fd = this.openFor(dateKey(record));
      const buffer = Buffer.from(line, "utf8");
      let offset = 0;
      while (offset < buffer.length) offset += writeSync(fd, buffer, offset);
    } catch (error) {
      this.disable(error);
    }
  }

  flush(): void {
    if (this.disabled || this.fd === undefined) return;
    try {
      fsyncSync(this.fd);
    } catch (error) {
      this.disable(error);
    }
  }

  close(): void {
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

  private openFor(date: string): number {
    if (this.fd !== undefined && this.currentDate === date) return this.fd;
    this.close();
    mkdirSync(this.directory, { recursive: true });
    const path = join(this.directory, `server-${this.environment}-${date}.log`);
    this.fd = openSync(path, "a");
    this.currentDate = date;
    return this.fd;
  }

  private disable(error: unknown): void {
    if (this.disabled) return;
    this.disabled = true;
    this.close();
    this.onError?.(error);
  }
}
