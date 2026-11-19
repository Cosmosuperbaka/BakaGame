import { describe, expect, it } from "vitest";
import type {
  PublicStatusEvent,
  PublicStatusHistory,
  PublicStatusRealtime,
  PublicStatusSnapshot,
} from "@bakagame/shared";
import {
  ALL_COMPONENTS,
  buildMonthCells,
  buildRealtimeCells,
  groupSummaryOf,
  headlineOf,
  meanOf,
  tallyOf,
} from "./StatusCells";
import { beijingDayStart } from "./StatusFormat";

const INTERVAL = 180_000;
const WINDOW = INTERVAL * 4;
const GENERATED_AT = 10 * INTERVAL + 50_000;

const realtime: PublicStatusRealtime = {
  intervalMs: INTERVAL,
  windowMs: WINDOW,
  generatedAt: GENERATED_AT,
  entries: [
    {
      id: "bangumi",
      uptime: 0.5,
      cells: [
        { start: 10 * INTERVAL, total: 2, ratio: 1, level: "operational", latencyMs: 150 },
        { start: 8 * INTERVAL, total: 1, ratio: 0, level: "degraded", latencyMs: null },
      ],
    },
  ],
};

const incident = (over: Partial<PublicStatusEvent> = {}): PublicStatusEvent => ({
  id: 1,
  kind: "incident",
  title: "故障",
  body: "",
  status: "investigating",
  components: ["bangumi"],
  startedAt: 10 * INTERVAL,
  plannedEndAt: null,
  resolvedAt: null,
  updatedAt: 10 * INTERVAL,
  ...over,
});

describe("buildRealtimeCells", () => {
  it("按服务端窗口参数出格，最新一格对齐采样间隔，缺样本的时段补空格", () => {
    const cells = buildRealtimeCells(realtime, []).get("bangumi")!;
    expect(cells).toHaveLength(4);
    // 左旧右新：最后一格起点是 generatedAt 向下取整到间隔。
    expect(cells.map((cell) => cell.key)).toEqual([
      `r${7 * INTERVAL}`,
      `r${8 * INTERVAL}`,
      `r${9 * INTERVAL}`,
      `r${10 * INTERVAL}`,
    ]);
    expect(cells.map((cell) => cell.total)).toEqual([0, 1, 0, 2]);
    expect(cells[0]!.level).toBe("unknown");
    expect(cells[3]).toMatchObject({ level: "operational", ratio: 1, latencyMs: 150 });
  });

  it("没有条目的组件也补满空格，且只挂上压在该时段的相关事件", () => {
    const result = buildRealtimeCells(realtime, [incident()]);
    expect(result.size).toBe(ALL_COMPONENTS.length);
    const bangumi = result.get("bangumi")!;
    // 事件从最后一格开始，还没恢复：只压住最后一格。
    expect(bangumi.map((cell) => cell.events.length)).toEqual([0, 0, 0, 1]);
    // 受影响组件之外的行不挂这条事件。
    expect(result.get("netease")!.every((cell) => cell.events.length === 0)).toBe(true);
  });
});

describe("buildMonthCells", () => {
  const history: PublicStatusHistory = {
    days: 2,
    generatedAt: 0,
    entries: [
      {
        id: "backend",
        uptime: [{ days: 30, ratio: 1 }],
        latencyMs: null,
        cells: [
          { day: "2026-10-21", total: 12, ratio: 1, level: "operational", latencyMs: null },
          { day: "2026-10-22", total: 12, ratio: 0.4, level: "degraded", latencyMs: null },
        ],
      },
    ],
  };

  it("缺条目的组件按同一串日子补空格", () => {
    const result = buildMonthCells(history, []);
    expect(result.get("backend")!.map((cell) => cell.key)).toEqual(["d2026-10-21", "d2026-10-22"]);
    const filler = result.get("netease")!;
    expect(filler.map((cell) => cell.key)).toEqual(["d2026-10-21", "d2026-10-22"]);
    expect(filler.every((cell) => cell.total === 0 && cell.level === "unknown")).toBe(true);
  });

  it("日格边界是北京自然日：压在前一天 UTC 傍晚的事件算进该北京日", () => {
    const start = beijingDayStart("2026-10-22");
    // 事件在该北京日零点后一小时开始、两小时后恢复：只压 10-22，不压 10-21。
    const event = incident({
      components: ["backend"],
      startedAt: start + 3_600_000,
      resolvedAt: start + 7_200_000,
    });
    const cells = buildMonthCells(history, [event]).get("backend")!;
    expect(cells.map((cell) => cell.events.length)).toEqual([0, 1]);
  });
});

describe("汇总计算", () => {
  const snapshot = (level: "operational" | "degraded"): PublicStatusSnapshot => ({
    observedAt: 1,
    level,
    version: "v",
    components: [],
  });

  it("meanOf 只算有结论的值，全无结论读 null", () => {
    expect(meanOf([1, null, 0.5])).toBe(0.75);
    expect(meanOf([null, null])).toBeNull();
  });

  it("headlineOf 按快照有无、读取失败与各档数量给出主卡文案", () => {
    const all = tallyOf(ALL_COMPONENTS, () => "operational");
    expect(headlineOf(null, all, false).title).toBe("正在读取服务状态…");
    expect(headlineOf(null, all, true).title).toBe("暂时读不到服务状态");
    expect(headlineOf(snapshot("operational"), all, false).title).toBe("所有系统运行正常");

    const mixed = tallyOf(ALL_COMPONENTS, (id) => (id === "qq" ? "degraded" : "operational"));
    expect(headlineOf(snapshot("degraded"), mixed, false)).toMatchObject({
      title: "1 项服务异常",
      names: expect.any(Array),
    });

    const unknown = tallyOf(ALL_COMPONENTS, () => "unknown");
    expect(headlineOf(snapshot("operational"), unknown, false).title).toBe("暂时无法确认服务状态");
  });

  it("groupSummaryOf 异常优先，其次未知，最后全部正常", () => {
    const ids = ALL_COMPONENTS.slice(0, 3);
    expect(
      groupSummaryOf(
        tallyOf(ids, () => "operational"),
        3
      )
    ).toBe("全部正常");
    expect(
      groupSummaryOf(
        tallyOf(ids, () => "unknown"),
        3
      )
    ).toBe("暂无监测结论");
    expect(
      groupSummaryOf(
        tallyOf(ids, (id) => (id === ids[0] ? "degraded" : "unknown")),
        3
      )
    ).toBe("1 项异常");
  });
});
