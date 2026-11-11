import { describe, expect, test } from "bun:test";
import { StatusHistoryStore } from "../src/infrastructure/StatusHistoryStore";
import { StatusSampleStore } from "../src/infrastructure/StatusSampleStore";
import { createDrizzleStub } from "./DrizzleStub";
import {
  PUBLIC_STATUS_COMPONENT_IDS,
  type PublicStatusHistoryEntry,
  type PublicStatusLevel,
  type PublicStatusSnapshot,
} from "../src/shared/Status";

const DAY_MS = 86_400_000;
/** 固定在一个北京时间的白天中段，避免用例正好跨过自然日边界而抖动。 */
const NOW = Date.parse("2026-10-23T04:00:00Z");

const snapshotAt = (observedAt: number, level: PublicStatusLevel): PublicStatusSnapshot => ({
  observedAt,
  level: level === "degraded" ? "degraded" : "operational",
  version: "V1.2.3",
  components: PUBLIC_STATUS_COMPONENT_IDS.map((id) => ({
    id,
    level,
    latencyMs: id === "bangumi" ? 120 : null,
  })),
});

const entryOf = (history: { entries: PublicStatusHistoryEntry[] }, id: string) => {
  const entry = history.entries.find((item) => item.id === id);
  if (!entry) throw new Error(`历史里缺少组件 ${id}`);
  return entry;
};

describe("状态账本的落库失败", () => {
  test("读取失败抛给调用方告警，而不是静默成空历史", async () => {
    const stub = createDrizzleStub().reject(0, new Error("连接被拒"));
    const store = new StatusHistoryStore({ environment: "production", database: stub.database });
    await expect(store.load()).rejects.toMatchObject({ cause: { message: "连接被拒" } });
  });

  test("写库失败先抛出，下一轮 flush 不靠新样本也会把同一批账重写", async () => {
    const stub = createDrizzleStub().reject(0, new Error("写入超时"));
    const store = new StatusHistoryStore({
      environment: "production",
      database: stub.database,
      now: () => NOW,
    });
    store.record(snapshotAt(NOW, "operational"));
    await expect(store.flush()).rejects.toMatchObject({ cause: { message: "写入超时" } });

    await store.flush();
    expect(stub.queries).toHaveLength(2);
    expect(stub.queryAt(1).statement).toContain("insert into `status_daily`");
  });

  test("实时样本账本同口径：读写失败都抛出，失败的那批键留待重试", async () => {
    const readStub = createDrizzleStub().reject(0, new Error("连接被拒"));
    await expect(
      new StatusSampleStore({ environment: "production", database: readStub.database }).load()
    ).rejects.toMatchObject({ cause: { message: "连接被拒" } });

    const writeStub = createDrizzleStub().reject(0, new Error("写入超时"));
    const samples = new StatusSampleStore({
      environment: "production",
      database: writeStub.database,
      now: () => NOW,
    });
    samples.record(snapshotAt(NOW, "operational"));
    await expect(samples.flush()).rejects.toMatchObject({ cause: { message: "写入超时" } });
    await samples.flush();
    expect(writeStub.queries).toHaveLength(2);
  });
});

describe("状态历史账本", () => {
  test("没有数据库也照常记账，读得出日格", () => {
    const store = new StatusHistoryStore({ environment: "production", now: () => NOW });
    store.record(snapshotAt(NOW, "operational"));
    store.record(snapshotAt(NOW, "operational"));

    const history = store.read(7);
    expect(history.days).toBe(7);
    expect(history.entries).toHaveLength(PUBLIC_STATUS_COMPONENT_IDS.length);
    const backend = entryOf(history, "backend");
    expect(backend.cells).toHaveLength(7);
    // 只有今天有样本，其余 6 天是补出来的空格子。
    const sampled = backend.cells.filter((cell) => cell.total > 0);
    expect(sampled).toHaveLength(1);
    expect(sampled[0].total).toBe(2);
    expect(sampled[0].ratio).toBe(1);
    expect(sampled[0].level).toBe("operational");
  });

  test("未探到的日子读作无数据，不冒充 0%", () => {
    const store = new StatusHistoryStore({ environment: "production", now: () => NOW });
    const empty = entryOf(store.read(7), "backend");
    expect(empty.cells.every((cell) => cell.total === 0 && cell.ratio === null)).toBe(true);
    expect(empty.uptime.map((span) => span.ratio)).toEqual([null]);
  });

  test("降级日按有结论样本占比读，unknown 不进分母", () => {
    const store = new StatusHistoryStore({ environment: "production", now: () => NOW });
    store.record(snapshotAt(NOW, "operational"));
    store.record(snapshotAt(NOW, "operational"));
    store.record(snapshotAt(NOW, "degraded"));
    // unknown 只是「没有结论」：既不拉低可用率，也不抬高真故障。
    store.record(snapshotAt(NOW, "unknown"));

    const backend = entryOf(store.read(7), "backend");
    const today = backend.cells.find((cell) => cell.total === 4);
    expect(today?.ratio).toBeCloseTo(2 / 3);
    expect(today?.level).toBe("degraded");
  });

  test("全 unknown 的日子读作无结论：ratio null、level unknown", () => {
    const store = new StatusHistoryStore({ environment: "production", now: () => NOW });
    store.record(snapshotAt(NOW, "unknown"));
    store.record(snapshotAt(NOW, "unknown"));

    const backend = entryOf(store.read(7), "backend");
    const today = backend.cells.find((cell) => cell.total === 2);
    expect(today?.ratio).toBeNull();
    expect(today?.level).toBe("unknown");
    expect(backend.uptime.map((span) => span.ratio)).toEqual([null]);
  });

  test("operational 与 unknown 混合：可用率仍是 1，等级读作 operational", () => {
    const store = new StatusHistoryStore({ environment: "production", now: () => NOW });
    store.record(snapshotAt(NOW, "operational"));
    store.record(snapshotAt(NOW, "unknown"));

    const backend = entryOf(store.read(7), "backend");
    const today = backend.cells.find((cell) => cell.total === 2);
    expect(today?.ratio).toBe(1);
    expect(today?.level).toBe("operational");
    expect(backend.uptime[0]?.ratio).toBe(1);
  });

  test("窗口可用率直接按原始计数算，跨天混入 unknown 不进分母", () => {
    const store = new StatusHistoryStore({ environment: "production", now: () => NOW });
    store.record(snapshotAt(NOW - DAY_MS, "operational"));
    store.record(snapshotAt(NOW - DAY_MS, "degraded"));
    store.record(snapshotAt(NOW, "operational"));
    store.record(snapshotAt(NOW, "unknown"));

    const backend = entryOf(store.read(30), "backend");
    // 两天合计 2 operational、1 degraded、1 unknown：分母只算有结论的 3。
    expect(backend.uptime.find((span) => span.days === 30)?.ratio).toBeCloseTo(2 / 3);
  });

  test("窗口只取最近 30 天，跨天分别累计", () => {
    const store = new StatusHistoryStore({ environment: "production", now: () => NOW });
    // 20 天前的一天全部异常，最近一天全部正常：两格都读得到，窗口可用率把两天合起来算。
    store.record(snapshotAt(NOW - 20 * DAY_MS, "degraded"));
    store.record(snapshotAt(NOW, "operational"));

    const backend = entryOf(store.read(30), "backend");
    const month = backend.uptime.find((span) => span.days === 30);
    expect(month?.ratio).toBeCloseTo(0.5);
    const sampled = backend.cells.filter((cell) => cell.total > 0);
    expect(sampled).toHaveLength(2);
    expect(sampled.find((cell) => cell.level === "degraded")).toBeDefined();
    expect(sampled.find((cell) => cell.level === "operational")).toBeDefined();
  });

  test("超出保留窗口的旧账被裁掉", () => {
    const store = new StatusHistoryStore({
      environment: "production",
      now: () => NOW,
      retentionDays: 3,
    });
    store.record(snapshotAt(NOW - 40 * DAY_MS, "operational"));
    store.record(snapshotAt(NOW, "operational"));

    const backend = entryOf(store.read(3), "backend");
    expect(backend.cells.filter((cell) => cell.total > 0)).toHaveLength(1);
  });
});
