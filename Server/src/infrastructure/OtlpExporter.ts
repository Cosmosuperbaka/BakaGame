export interface OtlpExporterConfig {
  endpoint?: string;
  headers?: Record<string, string>;
  serviceName?: string;
  serviceNamespace?: string;
  deploymentEnvironment?: string;
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
  /** 兼容旧代码引用 */
  readonly endpoint?: string;
  private readonly headers: Record<string, string>;
  readonly serviceName: string;
  readonly serviceNamespace?: string;
  readonly deploymentEnvironment?: string;

  private logBuffer: OtlpLogRecord[] = [];
  private spanBuffer: OtlpSpanRecord[] = [];
  private flushTimer: ReturnType<typeof setInterval> | null = null;
  private isShuttingDown = false;
  private flushingLogsPromise: Promise<void> | null = null;
  private flushingSpansPromise: Promise<void> | null = null;

  constructor(config: OtlpExporterConfig = {}) {
    if (config.endpoint) {
      const base = config.endpoint.replace(/\/$/, "");
      const root = base.replace(/\/v1\/(logs|traces|metrics)$/, "");
      this.logsEndpoint = `${root}/v1/logs`;
      this.tracesEndpoint = `${root}/v1/traces`;
      this.endpoint = this.logsEndpoint;
    }
    this.headers = {
      "Content-Type": "application/json",
      ...(config.headers ?? {}),
    };
    this.serviceName = config.serviceName ?? "Bakagame-Server";
    this.serviceNamespace = config.serviceNamespace ?? "Bakagame";
    this.deploymentEnvironment = config.deploymentEnvironment ?? "production";

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
    }
    this.spanBuffer.push(record);
    if (this.spanBuffer.length >= 50) {
      void this.flushSpans();
    }
  }

  async sendHeartbeatTrace(): Promise<boolean> {
    if (!this.tracesEndpoint) return false;
    const now = Date.now();
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
    await this.flushSpans();
    return true;
  }

  async flushLogs(): Promise<void> {
    if (!this.logsEndpoint) return;
    if (this.flushingLogsPromise) {
      await this.flushingLogsPromise;
    }
    if (this.logBuffer.length === 0) return;

    const batch = this.logBuffer;
    this.logBuffer = [];

    this.flushingLogsPromise = (async () => {
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

        await fetch(this.logsEndpoint!, {
          method: "POST",
          headers: this.headers,
          body: JSON.stringify({ resourceLogs }),
          signal: AbortSignal.timeout(5000),
        });
      } catch {
        // 观测服务上报失败或组装异常时不阻塞业务主流程
      } finally {
        this.flushingLogsPromise = null;
      }
    })();

    await this.flushingLogsPromise;
  }

  async flushSpans(): Promise<void> {
    if (!this.tracesEndpoint) return;
    if (this.flushingSpansPromise) {
      await this.flushingSpansPromise;
    }
    if (this.spanBuffer.length === 0) return;

    const batch = this.spanBuffer;
    this.spanBuffer = [];

    this.flushingSpansPromise = (async () => {
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

        await fetch(this.tracesEndpoint!, {
          method: "POST",
          headers: this.headers,
          body: JSON.stringify({ resourceSpans }),
          signal: AbortSignal.timeout(5000),
        });
      } catch {
        // 观测服务上报失败或组装异常时不阻塞业务主流程
      } finally {
        this.flushingSpansPromise = null;
      }
    })();

    await this.flushingSpansPromise;
  }

  async flush(): Promise<void> {
    await Promise.all([this.flushLogs(), this.flushSpans()]);
  }

  async shutdown(): Promise<void> {
    this.isShuttingDown = true;
    if (this.flushTimer) {
      clearInterval(this.flushTimer);
      this.flushTimer = null;
    }
    await this.flush();
  }
}

