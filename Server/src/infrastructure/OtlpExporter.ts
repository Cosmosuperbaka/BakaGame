export type OtlpFetcher = (
  input: string | URL | Request,
  init?: RequestInit,
) => Promise<Response>;

export interface OtlpExporterConfig {
  endpoint?: string;
  headers?: Record<string, string>;
  serviceName?: string;
  serviceNamespace?: string;
  deploymentEnvironment?: string;
  fetcher?: typeof fetch | OtlpFetcher;
  now?: () => number;
}

export interface OtlpLogRecord {
  timestamp: number;
  level: "INFO" | "WARN" | "ERROR";
  message: string;
  traceId?: string;
  attributes?: Record<string, unknown>;
}

export interface OtlpSpanRecord {
  name: string;
  traceId?: string;
  spanId?: string;
  parentSpanId?: string;
  startTime: number;
  endTime: number;
  attributes?: Record<string, unknown>;
  status?: "OK" | "ERROR";
  statusMessage?: string;
}

export interface OtlpExporterStats {
  totalAttempts: number;
  successCount: number;
  failureCount: number;
  droppedCount: number;
  consecutiveFailures: number;
}

export interface OtlpFlushResult {
  success: boolean;
  attempted: number;
  sent: number;
  remaining: number;
  dropped: number;
}

export class OtlpShutdownError extends Error {
  constructor(readonly result: OtlpFlushResult, readonly stats: OtlpExporterStats) {
    super(`OTLP shutdown did not drain: ${result.remaining} remaining, ${result.dropped} dropped`);
    this.name = "OtlpShutdownError";
  }
}

export const formatOtlpTraceId = (traceId?: string): string => {
  if (!traceId) {
    return crypto.randomUUID().replace(/-/g, "").toLowerCase();
  }
  const clean = traceId.replace(/[^a-fA-F0-9]/g, "").toLowerCase();
  if (clean.length === 32) return clean;
  if (clean.length > 32) return clean.slice(0, 32);
  return clean.padEnd(32, "0");
};

export const formatOtlpSpanId = (spanId?: string): string => {
  if (!spanId) {
    return crypto.randomUUID().replace(/-/g, "").slice(0, 16).toLowerCase();
  }
  const clean = spanId.replace(/[^a-fA-F0-9]/g, "").toLowerCase();
  if (clean.length === 16) return clean;
  if (clean.length > 16) return clean.slice(0, 16);
  return clean.padEnd(16, "0");
};

export const toUnixNanoString = (timeMs: number): string => {
  if (!Number.isFinite(timeMs) || timeMs < 0) {
    return String(BigInt(Date.now()) * 1_000_000n);
  }
  const ms = Math.trunc(timeMs);
  const nanos = Math.round((timeMs - ms) * 1_000_000);
  return String(BigInt(ms) * 1_000_000n + BigInt(nanos));
};

const toAnyValue = (v: unknown): Record<string, unknown> => {
  if (typeof v === "boolean") return { boolValue: v };
  if (typeof v === "number") {
    if (Number.isInteger(v)) return { intValue: v };
    return { doubleValue: v };
  }
  if (typeof v === "string") return { stringValue: v };
  return { stringValue: JSON.stringify(v) };
};

export class OtlpExporter {
  private static readonly MAX_BUFFER_SIZE = 500;
  readonly logsEndpoint?: string;
  readonly tracesEndpoint?: string;
  private readonly headers: Record<string, string>;
  readonly serviceName: string;
  readonly serviceNamespace?: string;
  readonly deploymentEnvironment?: string;
  private readonly fetcher: typeof fetch | OtlpFetcher;
  private readonly now: () => number;

  private logBuffer: OtlpLogRecord[] = [];
  private spanBuffer: OtlpSpanRecord[] = [];
  private flushTimer: ReturnType<typeof setInterval> | null = null;
  private isShuttingDown = false;
  private flushingLogsPromise: Promise<boolean> | null = null;
  private flushingSpansPromise: Promise<boolean> | null = null;

  private shutdownPromise: Promise<void> | null = null;
  private readonly requests = new Set<AbortController>();
  private inFlightRecords = 0;
  private sentRecords = 0;
  private shutdownDeadline = Infinity;
  private nextRetryTime = 0;
  private readonly stats: OtlpExporterStats = {
    totalAttempts: 0,
    successCount: 0,
    failureCount: 0,
    droppedCount: 0,
    consecutiveFailures: 0,
  };

  constructor(config: OtlpExporterConfig = {}) {
    if (config.endpoint) {
      const base = config.endpoint.replace(/\/$/, "");
      const root = base.replace(/\/v1\/(logs|traces|metrics)$/, "");
      this.logsEndpoint = `${root}/v1/logs`;
      this.tracesEndpoint = `${root}/v1/traces`;
    }
    this.headers = {
      "Content-Type": "application/json",
      ...(config.headers ?? {}),
    };
    this.serviceName = config.serviceName ?? "Bakagame-Server";
    this.serviceNamespace = config.serviceNamespace ?? "Bakagame";
    this.deploymentEnvironment = config.deploymentEnvironment ?? "production";
    this.fetcher = config.fetcher ?? fetch;
    this.now = config.now ?? (() => Date.now());

    if (this.logsEndpoint || this.tracesEndpoint) {
      this.flushTimer = setInterval(() => {
        void this.flush().catch(() => {});
      }, 3000);
      if (typeof this.flushTimer?.unref === "function") {
        this.flushTimer.unref();
      }
    }
  }

  get isEnabled(): boolean {
    return Boolean(this.logsEndpoint || this.tracesEndpoint);
  }

  get buffer(): OtlpLogRecord[] {
    return this.logBuffer;
  }

  getStats(): OtlpExporterStats {
    return { ...this.stats };
  }

  getResourceAttributes(): Array<{ key: string; value: { stringValue: string } }> {
    const attrs: Array<{ key: string; value: { stringValue: string } }> = [
      {
        key: "service.name",
        value: { stringValue: this.serviceName },
      },
    ];
    if (this.serviceNamespace) {
      attrs.push({
        key: "service.namespace",
        value: { stringValue: this.serviceNamespace },
      });
    }
    if (this.deploymentEnvironment) {
      attrs.push({
        key: "deployment.environment",
        value: { stringValue: this.deploymentEnvironment },
      });
    }
    return attrs;
  }

  enqueue(record: OtlpLogRecord): void {
    if (!this.logsEndpoint || this.isShuttingDown) return;
    if (this.logBuffer.length >= OtlpExporter.MAX_BUFFER_SIZE) {
      this.logBuffer.shift(); // 缓冲区达上限时淘汰最旧条目
      this.stats.droppedCount++;
    }
    this.logBuffer.push(record);
    if (this.logBuffer.length >= 50) {
      void this.flushLogs();
    }
  }

  enqueueSpan(record: OtlpSpanRecord): void {
    if (!this.tracesEndpoint || this.isShuttingDown) return;
    if (this.spanBuffer.length >= OtlpExporter.MAX_BUFFER_SIZE) {
      this.spanBuffer.shift();
      this.stats.droppedCount++;
    }
    this.spanBuffer.push(record);
    if (this.spanBuffer.length >= 50) {
      void this.flushSpans();
    }
  }

  private handleFailure(batch: OtlpLogRecord[] | OtlpSpanRecord[], type: "logs" | "spans"): void {
    this.stats.failureCount++;
    this.stats.consecutiveFailures++;
    const backoffMs = Math.min(30000, 1000 * Math.pow(2, this.stats.consecutiveFailures - 1));
    this.nextRetryTime = this.now() + backoffMs;

    if (type === "logs") {
      this.logBuffer.unshift(...(batch as OtlpLogRecord[]));
      if (this.logBuffer.length > OtlpExporter.MAX_BUFFER_SIZE) {
        const excess = this.logBuffer.length - OtlpExporter.MAX_BUFFER_SIZE;
        this.logBuffer.splice(0, excess);
        this.stats.droppedCount += excess;
      }
    } else {
      this.spanBuffer.unshift(...(batch as OtlpSpanRecord[]));
      if (this.spanBuffer.length > OtlpExporter.MAX_BUFFER_SIZE) {
        const excess = this.spanBuffer.length - OtlpExporter.MAX_BUFFER_SIZE;
        this.spanBuffer.splice(0, excess);
        this.stats.droppedCount += excess;
      }
    }
  }

  async sendHeartbeatTrace(): Promise<boolean> {
    if (!this.tracesEndpoint) return false;
    const now = this.now();
    this.enqueueSpan({
      name: "server.startup",
      startTime: now - 50,
      endTime: now,
      status: "OK",
      attributes: {
        "server.status": "ready",
        "service.type": "bakagame",
      },
    });
    return await this.flushSpans();
  }

  // 注入 fetcher 也必须遵守期限；race 确保不响应 signal 的 mock 不会挂住停机。
  private async post(endpoint: string, body: unknown): Promise<Response> {
    const controller = new AbortController();
    this.requests.add(controller);
    let timer: ReturnType<typeof setTimeout> | undefined;
    let onAbort: (() => void) | undefined;
    try {
      const aborted = new Promise<never>((_resolve, reject) => {
        onAbort = () => reject(new Error("OTLP request aborted"));
        controller.signal.addEventListener("abort", onAbort, { once: true });
      });
      const timeoutMs = Math.max(0, Math.min(5000, this.shutdownDeadline - performance.now()));
      const timeout = new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => {
          controller.abort();
          reject(new Error("OTLP request timed out"));
        }, timeoutMs);
      });
      return await Promise.race([this.fetcher(endpoint, {
        method: "POST", headers: this.headers, body: JSON.stringify(body), signal: controller.signal,
      }), timeout, aborted]);
    } finally {
      if (timer !== undefined) clearTimeout(timer);
      if (onAbort) controller.signal.removeEventListener("abort", onAbort);
      this.requests.delete(controller);
    }
  }

  async flushLogs(force = false): Promise<boolean> {
    if (!this.logsEndpoint) return false;
    if (this.flushingLogsPromise) {
      await this.flushingLogsPromise;
    }
    if (this.logBuffer.length === 0) return true;
    if (!force && this.now() < this.nextRetryTime) return false;

    const batch = this.logBuffer;
    this.logBuffer = [];
    this.inFlightRecords += batch.length;

    this.flushingLogsPromise = (async (): Promise<boolean> => {
      this.stats.totalAttempts++;
      try {
        const resourceLogs = [
          {
            resource: {
              attributes: this.getResourceAttributes(),
            },
            scopeLogs: [
              {
                scope: { name: "bakagame-logger" },
                logRecords: batch.map((item) => ({
                  timeUnixNano: toUnixNanoString(item.timestamp),
                  severityNumber: item.level === "ERROR" ? 17 : item.level === "WARN" ? 13 : 9,
                  severityText: item.level,
                  body: { stringValue: item.message },
                  attributes: Object.entries({
                    ...(item.attributes ?? {}),
                    ...(item.traceId ? { trace_id: item.traceId } : {}),
                  }).map(([k, v]) => ({
                    key: k,
                    value: {
                      stringValue: typeof v === "string" ? v : JSON.stringify(v),
                    },
                  })),
                })),
              },
            ],
          },
        ];

        const response = await this.post(this.logsEndpoint!, { resourceLogs });

        if (response.ok) {
          this.sentRecords += batch.length;
          this.stats.successCount++;
          this.stats.consecutiveFailures = 0;
          this.nextRetryTime = 0;
          return true;
        }

        this.handleFailure(batch, "logs");
        return false;
      } catch {
        this.handleFailure(batch, "logs");
        return false;
      } finally {
        this.inFlightRecords -= batch.length;
      }
    })();

    try { return await this.flushingLogsPromise; }
    finally { this.flushingLogsPromise = null; }
  }

  async flushSpans(force = false): Promise<boolean> {
    if (!this.tracesEndpoint) return false;
    if (this.flushingSpansPromise) {
      await this.flushingSpansPromise;
    }
    if (this.spanBuffer.length === 0) return true;
    if (!force && this.now() < this.nextRetryTime) return false;

    const batch = this.spanBuffer;
    this.spanBuffer = [];
    this.inFlightRecords += batch.length;

    this.flushingSpansPromise = (async (): Promise<boolean> => {
      this.stats.totalAttempts++;
      try {
        const resourceSpans = [
          {
            resource: {
              attributes: this.getResourceAttributes(),
            },
            scopeSpans: [
              {
                scope: { name: "bakagame-tracer", version: "1.0.0" },
                spans: batch.map((item) => ({
                  traceId: formatOtlpTraceId(item.traceId),
                  spanId: formatOtlpSpanId(item.spanId),
                  ...(item.parentSpanId ? { parentSpanId: formatOtlpSpanId(item.parentSpanId) } : {}),
                  name: item.name,
                  kind: 1, // SPAN_KIND_INTERNAL
                  startTimeUnixNano: toUnixNanoString(item.startTime),
                  endTimeUnixNano: toUnixNanoString(item.endTime),
                  attributes: Object.entries(item.attributes ?? {}).map(([k, v]) => ({
                    key: k,
                    value: toAnyValue(v),
                  })),
                  status: {
                    code: item.status === "ERROR" ? 2 : 1,
                    ...(item.statusMessage ? { message: item.statusMessage } : {}),
                  },
                })),
              },
            ],
          },
        ];

        const response = await this.post(this.tracesEndpoint!, { resourceSpans });

        if (response.ok) {
          this.sentRecords += batch.length;
          this.stats.successCount++;
          this.stats.consecutiveFailures = 0;
          this.nextRetryTime = 0;
          return true;
        }

        this.handleFailure(batch, "spans");
        return false;
      } catch {
        this.handleFailure(batch, "spans");
        return false;
      } finally {
        this.inFlightRecords -= batch.length;
      }
    })();

    try { return await this.flushingSpansPromise; }
    finally { this.flushingSpansPromise = null; }
  }

  private result(attemptsBefore: number, sentBefore: number): OtlpFlushResult {
    const remaining = this.logBuffer.length + this.spanBuffer.length + this.inFlightRecords;
    return { success: remaining === 0, attempted: this.stats.totalAttempts - attemptsBefore,
      sent: this.sentRecords - sentBefore, remaining, dropped: this.stats.droppedCount };
  }

  async flush(): Promise<OtlpFlushResult> {
    const attemptsBefore = this.stats.totalAttempts;
    const sentBefore = this.sentRecords;
    await Promise.all([this.flushLogs(), this.flushSpans()]);
    return this.result(attemptsBefore, sentBefore);
  }

  shutdown(timeoutMs = 10_000): Promise<void> {
    if (this.shutdownPromise) return this.shutdownPromise;
    this.isShuttingDown = true;
    if (this.flushTimer) {
      clearInterval(this.flushTimer);
      this.flushTimer = null;
    }
    const attemptsBefore = this.stats.totalAttempts;
    const sentBefore = this.sentRecords;
    const budget = Number.isFinite(timeoutMs) ? Math.max(0, timeoutMs) : 10_000;
    this.shutdownDeadline = performance.now() + budget;
    this.shutdownPromise = (async () => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        const drain = async () => {
          // 先等运行期请求归还 batch，再有界绕过退避做一次最终尝试。
          await Promise.all([this.flushingLogsPromise, this.flushingSpansPromise]);
          if (performance.now() < this.shutdownDeadline) {
            await Promise.all([this.flushLogs(true), this.flushSpans(true)]);
          }
        };
        await Promise.race([drain(), new Promise<void>((resolve) => {
          timer = setTimeout(() => {
            for (const request of this.requests) request.abort();
            resolve();
          }, budget);
        })]);
        const result = this.result(attemptsBefore, sentBefore);
        if (!result.success) throw new OtlpShutdownError(result, this.getStats());
      } finally {
        if (timer !== undefined) clearTimeout(timer);
      }
    })();
    return this.shutdownPromise;
  }
}
