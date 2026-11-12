import { expect, test } from "bun:test";
import {
  addSample,
  cellFigures,
  emptyCount,
  latencyOf,
  ratioOf,
  sumCounts,
} from "../src/infrastructure/StatusCounts";

test("可用率分母只算有结论的样本：unknown 不进分母", () => {
  const count = emptyCount();
  addSample(count, "operational", 100);
  addSample(count, "degraded", null);
  addSample(count, "unknown", null);
  addSample(count, "unknown", null);
  expect(count.total).toBe(4);
  expect(ratioOf([count])).toBe(0.5);
  // 只有 unknown 时没有结论，不能读成 0%。
  const onlyUnknown = emptyCount();
  addSample(onlyUnknown, "unknown", null);
  expect(ratioOf([onlyUnknown])).toBeNull();
});

test("窗口延迟按样本加权，没有延迟读数的样本不冒充 0ms", () => {
  const busy = emptyCount();
  for (let i = 0; i < 3; i += 1) addSample(busy, "operational", 100);
  const quiet = emptyCount();
  addSample(quiet, "operational", 500);
  addSample(quiet, "degraded", null);
  // (300 + 500) / 4，而不是两格日均 (100 + 500) / 2。
  expect(latencyOf([busy, quiet])).toBe(200);
  expect(latencyOf([emptyCount()])).toBeNull();
});

test("格子等级：有降级即降级，其次正常，其余读作未知", () => {
  const mixed = emptyCount();
  addSample(mixed, "operational", null);
  addSample(mixed, "degraded", null);
  expect(cellFigures(mixed).level).toBe("degraded");
  const good = emptyCount();
  addSample(good, "operational", 80);
  expect(cellFigures(good)).toEqual({ total: 1, ratio: 1, level: "operational", latencyMs: 80 });
  expect(cellFigures(emptyCount()).level).toBe("unknown");
});

test("sumCounts 逐项相加且不改动入参", () => {
  const left = emptyCount();
  const right = emptyCount();
  addSample(left, "operational", 10);
  addSample(right, "degraded", 30);
  const sum = sumCounts(left, right);
  expect(sum).toMatchObject({
    total: 2,
    operational: 1,
    degraded: 1,
    latencySum: 40,
    latencyCount: 2,
  });
  expect(left.total).toBe(1);
});
