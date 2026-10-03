import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createTestApp } from "./AppFixtures";
import { EventLogger } from "../src/infrastructure/EventLogger";
import { WhoIsFakerService } from "../src/application/WhoIsFakerService";
import { WordBankRepository } from "../src/infrastructure/WordBankRepository";
import { createDocumentationApp } from "../src/scripts/ExportOpenapi";

function fixture(badHealth = false) {
  const dir = mkdtempSync(join(tmpdir(), "framework-contract-"));
  const operations: Array<{ status: number }> = [];
  const logger = new EventLogger(() => {});
  logger.logOperation = (operation) => { operations.push({ status: operation.status ?? 200 }); };
  const faker = new WhoIsFakerService({ eventLogger: logger, wordBankRepository: new WordBankRepository(join(dir, "words.json")) });
  if (badHealth) faker.getHealthSnapshot = () => ({ roomCount: Number.NaN, connectionCount: 0, onlinePlayerCount: 0 });
  const runtime = createTestApp({ env: { clientUrl: "https://allowed.invalid", serverUrl: "http://localhost", serverListenHost: "127.0.0.1", serverPort: 0, wordBankPath: join(dir, "words.json"), bangumiApiUrl: "https://unused.invalid", bangumiImageUrl: "", maintenanceToken: "fixture-token" }, whoIsFakerService: faker, logger });
  return { ...runtime, operations, cleanup: async () => { await runtime.dispose(); await faker.drainPendingWrites(); rmSync(dir, { recursive: true, force: true }); } };
}
const post = (body: string) => new Request("http://localhost/api/monitoring/telemetry", { method: "POST", headers: { "content-type": "application/json" }, body });
const completed = async () => { await new Promise(resolve => setImmediate(resolve)); };

describe("框架原生契约回归", () => {
  test("未知字段拒绝，非法JSON是400且错误日志只记最终结果", async () => {
    const f = fixture();
    try {
      expect((await f.app.handle(post(JSON.stringify({ message: "ok", unknown: true })))).status).toBe(422);
      const malformed = await f.app.handle(post("{broken"));
      expect(malformed.status).toBe(400);
      expect((await malformed.json()).error.code).toBe("INVALID_JSON");
      await completed();
      expect(f.operations.map(x => x.status)).toEqual([422, 400]);
    } finally { await f.cleanup(); }
  });
  test("Origin早退403保留追踪头和一条最终访问日志", async () => {
    const f = fixture();
    try {
      const response = await f.app.handle(new Request("http://localhost/api/whoisfaker/ws", { headers: { upgrade: "websocket", origin: "https://hostile.invalid" } }));
      expect(response.status).toBe(403);
      expect(response.headers.get("x-trace-id")).toBeTruthy();
      await completed(); expect(f.operations.map(x => x.status)).toEqual([403]);
    } finally { await f.cleanup(); }
  });
  test("不合输出schema属于500，不能预先记成功", async () => {
    const f = fixture(true);
    try {
      const response = await f.app.handle(new Request("http://localhost/health"));
      expect(response.status).toBe(500);
      await completed(); expect(f.operations.map(x => x.status)).toEqual([500]);
    } finally { await f.cleanup(); }
  });
  test("伪造私网头不能授权维护操作", async () => {
    const f = fixture();
    try {
      for (const ip of ["127.0.0.1", "10.0.0.1", "192.168.1.1"]) {
        const response = await f.app.handle(new Request("http://localhost/api/system/notify-shutdown", { method: "POST", headers: { "x-real-ip": ip, "x-forwarded-for": ip } }));
        expect(response.status).toBe(403);
      }
    } finally { await f.cleanup(); }
  });
  test("文档装配无需真实服务且声明503", async () => {
    const app = createDocumentationApp();
    const response = await app.handle(new Request("http://localhost/openapi/json"));
    const document = await response.json();
    expect(document.paths["/readyz"].get.responses[503]).toBeDefined();
    expect(document.paths["/api/monitoring/telemetry"]).toBeDefined();
    expect(document.info.title).toContain("BakaGame");
  });
});
