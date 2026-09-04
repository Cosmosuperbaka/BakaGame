import { readEnv } from "../config/Env";
import { OtlpExporter } from "../infrastructure/OtlpExporter";

const env = readEnv();

console.log("================================================================");
console.log("             BakaGame -> Grafana Cloud 连通性检测器              ");
console.log("================================================================");

if (!env.otelEndpoint) {
  console.log("⚠️ 未检测到 OTEL_EXPORTER_OTLP_ENDPOINT 环境变量！");
  console.log("\n请在 Server/.env 文件中添加如下配置（将占位符替换为你 Grafana 上的值）：");
  console.log("----------------------------------------------------------------");
  console.log("OTEL_EXPORTER_OTLP_ENDPOINT=https://otlp-gateway-prod-us-central-0.grafana.net/otlp");
  console.log("OTEL_EXPORTER_OTLP_HEADERS=Authorization=Basic <YOUR_BASE64_TOKEN>");
  console.log("OTEL_SERVICE_NAME=Bakagame-Server");
  console.log("OTEL_SERVICE_NAMESPACE=Bakagame");
  console.log("DEPLOYMENT_ENVIRONMENT=production");
  console.log("----------------------------------------------------------------\n");
  process.exit(1);
}

const exporter = new OtlpExporter({
  endpoint: env.otelEndpoint,
  headers: env.otelHeaders,
  serviceName: env.otelServiceName,
  serviceNamespace: env.otelServiceNamespace,
  deploymentEnvironment: env.otelDeploymentEnvironment,
});

console.log(`[1/3] 目标端点配置:`);
console.log(`  - Logs 端点:   ${exporter.logsEndpoint}`);
console.log(`  - Traces 端点: ${exporter.tracesEndpoint}`);
console.log(`  - 认证请求头:  ${env.otelHeaders ? "已配置 (Authorization=Basic ***)" : "未配置"}`);
console.log(`  - 服务标识:    service.name="${exporter.serviceName}"`);
console.log(`  - 命名空间:    service.namespace="${exporter.serviceNamespace}"`);
console.log(`  - 部署环境:    deployment.environment="${exporter.deploymentEnvironment}"`);

console.log("\n[2/3] 正在向 Grafana Cloud 发送验证数据包 (Traces & Logs)...");

try {
  const now = Date.now();
  const tracePayload = {
    resourceSpans: [
      {
        resource: { attributes: exporter.getResourceAttributes() },
        scopeSpans: [
          {
            scope: { name: "bakagame-tracer", version: "1.0.0" },
            spans: [
              {
                traceId: crypto.randomUUID().replace(/-/g, "").toLowerCase(),
                spanId: crypto.randomUUID().replace(/-/g, "").slice(0, 16).toLowerCase(),
                name: "server.startup",
                kind: 1,
                startTimeUnixNano: String(BigInt(now - 50) * 1_000_000n),
                endTimeUnixNano: String(BigInt(now) * 1_000_000n),
                attributes: [
                  { key: "server.status", value: { stringValue: "ready" } },
                  { key: "test.probe", value: { stringValue: "connection-check" } },
                ],
                status: { code: 1 },
              },
            ],
          },
        ],
      },
    ],
  };

  const traceRes = await fetch(exporter.tracesEndpoint!, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(env.otelHeaders ?? {}),
    },
    body: JSON.stringify(tracePayload),
  });

  if (!traceRes.ok) {
    const errorText = await traceRes.text();
    console.error(`\n❌ Grafana Cloud Traces 接口返回异常 (HTTP ${traceRes.status} ${traceRes.statusText})`);
    console.error(`响应内容: ${errorText}`);
    if (traceRes.status === 401 || traceRes.status === 403) {
      console.error("\n💡 排错建议：认证失败，请检查 OTEL_EXPORTER_OTLP_HEADERS 是否包含正确的 Basic Auth Token。");
      console.error("生成方式：Basic <Base64(Instance_ID:API_Token)>");
    }
    process.exit(1);
  }

  exporter.enqueue({
    timestamp: Date.now(),
    level: "INFO",
    message: "BakaGame Grafana Cloud connection verified successfully",
    attributes: {
      tester: "BakaGame-DevOps",
      status: "verified",
    },
  });
  await exporter.flushLogs();

  console.log("\n[3/3] 数据推送完毕！(HTTP 200 OK)");
  console.log("================================================================");
  console.log("✅ 成功！已向 Grafana Cloud (Tempo) 写入符合 TraceQL 检索的链路数据。");
  console.log("👉 请回到 Grafana 网页端，点击蓝色「Test connection」按钮，即可秒级通过！");
  console.log("================================================================");
} catch (err) {
  console.error("\n❌ 数据发送失败，网络或配置异常:", err);
  process.exit(1);
}
