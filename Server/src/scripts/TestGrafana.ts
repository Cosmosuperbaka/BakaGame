import { readEnv } from "../config/Env";
import { createOtelLogRecord } from "../infrastructure/logging/OtelLog";
import { OtlpExporter } from "../infrastructure/OtlpExporter";

const env = readEnv();

console.log("================================================================");
console.log("             BakaGame -> Grafana Cloud 连通性检测器              ");
console.log("================================================================");

if (!env.otelEndpoint) {
  console.log("⚠️ 未检测到 OTEL_EXPORTER_OTLP_ENDPOINT 环境变量！");
  console.log("\n请在 Server/.env 文件中添加如下配置（将占位符替换为你 Grafana 上的值）：");
  console.log("----------------------------------------------------------------");
  console.log("OTEL_EXPORTER_OTLP_ENDPOINT=https://otlp-gateway.example.com/otlp");
  console.log("OTEL_EXPORTER_OTLP_HEADERS=Authorization=Basic <YOUR_BASE64_TOKEN>");
  console.log("OTEL_SERVICE_NAME=Bakagame-Server");
  console.log("OTEL_SERVICE_NAMESPACE=Bakagame");
  console.log("DEPLOYMENT_ENVIRONMENT=production");
  console.log("----------------------------------------------------------------\n");
  process.exit(1);
}

/** 对端明确拒收（4xx）时导出器直接丢弃批次，状态码只能从汇报里拿到，用来给出排错提示。 */
const rejected: Array<{ signal: string; status?: number }> = [];

const exporter = new OtlpExporter({
  endpoint: env.otelEndpoint,
  headers: env.otelHeaders,
  serviceName: env.otelServiceName,
  serviceNamespace: env.otelServiceNamespace,
  deploymentEnvironment: env.otelDeploymentEnvironment,
  onDrop: (drop) => {
    if (drop.reason === "rejected") rejected.push({ signal: drop.signal, status: drop.status });
  },
});

console.log(`[1/3] 目标端点配置:`);
console.log(`  - Logs 端点:   ${exporter.logsEndpoint}`);
console.log(`  - Traces 端点: ${exporter.tracesEndpoint}`);
console.log(`  - 认证请求头:  ${env.otelHeaders ? "已配置 (Authorization=Basic ***)" : "未配置"}`);
console.log(`  - 服务标识:    service.name="${exporter.serviceName}"`);
console.log(`  - 命名空间:    service.namespace="${exporter.serviceNamespace}"`);
console.log(`  - 部署环境:    deployment.environment="${exporter.deploymentEnvironment}"`);

console.log("\n[2/3] 正在向 Grafana Cloud 发送验证数据包 (Traces & Logs)...");

/** 两路信号各自检查返回值：任何一路没送达都不能打印成功横幅。 */
const verify = async (): Promise<{ traces: boolean; logs: boolean }> => {
  const now = Date.now();
  exporter.enqueueSpan({
    traceId: crypto.randomUUID().replace(/-/g, "").toLowerCase(),
    name: "server.startup",
    startTime: now - 50,
    endTime: now,
    status: "OK",
    attributes: { "server.status": "ready", "test.probe": "connection-check" },
  });
  exporter.enqueue(
    createOtelLogRecord({
      createdAt: now,
      level: "info",
      body: "BakaGame Grafana Cloud connection verified successfully",
      attributes: { tester: "BakaGame-DevOps", status: "verified" },
    })
  );
  // force：忽略退避窗口，这是一次主动的连通性检测。导出器自带请求超时，不会无限挂住。
  const [traces, logs] = await Promise.all([exporter.flushSpans(true), exporter.flushLogs(true)]);
  return { traces, logs };
};

try {
  const result = await verify();
  if (!result.traces || !result.logs) {
    const failed = [!result.traces ? "Traces" : "", !result.logs ? "Logs" : ""].filter(Boolean);
    console.error(`\n❌ Grafana Cloud ${failed.join(" 与 ")} 数据未送达`);
    for (const item of rejected)
      console.error(`  - ${item.signal} 被对端拒收 (HTTP ${item.status ?? "未知"})`);
    if (rejected.some((item) => item.status === 401 || item.status === 403)) {
      console.error(
        "\n💡 排错建议：认证失败，请检查 OTEL_EXPORTER_OTLP_HEADERS 是否包含正确的 Basic Auth Token。"
      );
      console.error("生成方式：Basic <Base64(Instance_ID:API_Token)>");
    } else if (rejected.length === 0) {
      console.error("  - 未收到对端的明确拒绝：多为网络不通、超时或对端 5xx，请检查端点与网络。");
    }
    process.exit(1);
  }

  console.log("\n[3/3] 数据推送完毕！(Traces 与 Logs 均已送达)");
  console.log("================================================================");
  console.log("✅ 成功！已向 Grafana Cloud (Tempo) 写入符合 TraceQL 检索的链路数据。");
  console.log("👉 请回到 Grafana 网页端，点击蓝色「Test connection」按钮，即可秒级通过！");
  console.log("================================================================");
} catch (err) {
  console.error("\n❌ 数据发送失败，网络或配置异常:", err);
  process.exit(1);
}
