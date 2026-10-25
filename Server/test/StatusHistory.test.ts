import { describe, expect, test } from "bun:test";
import { StatusHistoryStore } from "../src/infrastructure/StatusHistoryStore";
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

  test("降级日按占比读，未知样本也计入分母", () => {
    const store = new StatusHistoryStore({ environment: "production", now: () => NOW });
    store.record(snapshotAt(NOW, "operational"));
    store.record(snapshotAt(NOW, "operational"));
    store.record(snapshotAt(NOW, "degraded"));
    // 未知同样是「没正常」：不因为读不到就把可用率抬上去。
    store.record(snapshotAt(NOW, "unknown"));

    const backend = entryOf(store.read(7), "backend");
    const today = backend.cells.find((cell) => cell.total === 4);
    expect(today?.ratio).toBeCloseTo(0.5);
    expect(today?.level).toBe("degraded");
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
