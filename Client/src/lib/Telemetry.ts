import { DEFAULT_SERVER_URL } from "@/config/Constants";
import { captureClientMessage, isClientSentryEnabled } from "./Sentry";

export interface TelemetryPayload {
  level?: "info" | "warn" | "error";
  message: string;
  traceId?: string;
  metadata?: Record<string, unknown>;
}

export interface TelemetryOptions {
  serverUrl?: string;
  fetcher?: typeof fetch;
}

export const reportTelemetry = async (
  payload: TelemetryPayload,
  options?: TelemetryOptions,
): Promise<void> => {
  try {
    const rawUrl = options?.serverUrl ?? (import.meta.env.VITE_SERVER_URL || DEFAULT_SERVER_URL);
    const serverUrl = rawUrl.replace(/\/+$/, "");
    const fetcher = options?.fetcher ?? fetch;
    const response = await fetcher(`${serverUrl}/api/monitoring/telemetry`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(payload.traceId ? { "x-trace-id": payload.traceId } : {}),
      },
      body: JSON.stringify(payload),
    });

    if (!response.ok) {
      console.warn(`[Telemetry] 上报遥测失败: HTTP ${response.status}`);
      throw new Error(`[Telemetry] HTTP ${response.status}`);
    }

    if (isClientSentryEnabled()) {
      captureClientMessage(
        payload.message,
        payload.level === "error" ? "error" : payload.level === "warn" ? "warning" : "info",
        {
          traceId: payload.traceId,
          ...payload.metadata,
        },
      );
    }
  } catch (error) {
    // 客户端监控上报失败不阻断用户交互，但记录本地告警
    if (!(error instanceof Error && error.message.includes("[Telemetry]"))) {
      console.warn("[Telemetry] 上报异常:", error);
    }
  }
};
