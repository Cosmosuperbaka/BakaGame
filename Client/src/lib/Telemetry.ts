import { DEFAULT_SERVER_URL } from "@/config/Constants";

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
    await fetcher(`${serverUrl}/api/monitoring/telemetry`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(payload.traceId ? { "x-trace-id": payload.traceId } : {}),
      },
      body: JSON.stringify(payload),
    });
  } catch {
    // 客户端监控上报失败不阻断用户交互
  }
};
