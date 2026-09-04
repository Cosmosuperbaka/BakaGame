import { DEFAULT_SERVER_URL } from "@/config/Constants";

export interface TelemetryPayload {
  level?: "info" | "warn" | "error";
  message: string;
  traceId?: string;
  metadata?: Record<string, unknown>;
}

export const reportTelemetry = async (payload: TelemetryPayload): Promise<void> => {
  try {
    const serverUrl = import.meta.env.VITE_SERVER_URL || DEFAULT_SERVER_URL;
    await fetch(`${serverUrl}/api/monitoring/telemetry`, {
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
