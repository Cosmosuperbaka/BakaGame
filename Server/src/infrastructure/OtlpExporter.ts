export interface OtlpExporterConfig {
  endpoint?: string;
  headers?: Record<string, string>;
  serviceName?: string;
}

export interface OtlpLogRecord {
  timestamp: number;
  level: "INFO" | "WARN" | "ERROR";
  message: string;
  traceId?: string;
  attributes?: Record<string, unknown>;
}

export class OtlpExporter {
  private readonly endpoint?: string;
  private readonly headers: Record<string, string>;
  private readonly serviceName: string;
  private buffer: OtlpLogRecord[] = [];
  private flushTimer: ReturnType<typeof setInterval> | null = null;
  private isShuttingDown = false;

  constructor(config: OtlpExporterConfig = {}) {
    if (config.endpoint) {
      const base = config.endpoint.replace(/\/$/, "");
      this.endpoint = base.endsWith("/v1/logs") ? base : `${base}/v1/logs`;
    }
    this.headers = {
      "Content-Type": "application/json",
      ...(config.headers ?? {}),
    };
    this.serviceName = config.serviceName ?? "bakagame-server";

    if (this.endpoint) {
      this.flushTimer = setInterval(() => {
        void this.flush();
      }, 3000);
      if (typeof this.flushTimer?.unref === "function") {
        this.flushTimer.unref();
      }
    }
  }

  get isEnabled(): boolean {
    return Boolean(this.endpoint);
  }

  enqueue(record: OtlpLogRecord): void {
    if (!this.endpoint || this.isShuttingDown) return;
    this.buffer.push(record);
    if (this.buffer.length >= 50) {
      void this.flush();
    }
  }

  async flush(): Promise<void> {
    if (!this.endpoint || this.buffer.length === 0) return;
    const batch = this.buffer;
    this.buffer = [];

    const resourceLogs = [
      {
        resource: {
          attributes: [
            {
              key: "service.name",
              value: { stringValue: this.serviceName },
            },
          ],
        },
        scopeLogs: [
          {
            scope: { name: "bakagame-logger" },
            logRecords: batch.map((item) => ({
              timeUnixNano: String(BigInt(item.timestamp) * 1_000_000n),
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

    try {
      await fetch(this.endpoint, {
        method: "POST",
        headers: this.headers,
        body: JSON.stringify({ resourceLogs }),
      });
    } catch {
      // 观测服务上报失败时不阻塞业务主流程
    }
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
