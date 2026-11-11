import {
  PUBLIC_STATUS_COMPONENT_IDS,
  PUBLIC_STATUS_HISTORY_DAYS,
  PUBLIC_STATUS_REALTIME_WINDOW_MS,
  PUBLIC_STATUS_SAMPLE_INTERVAL_MS,
} from "@bakagame/shared/values";
import type {
  PublicStatusCell,
  PublicStatusComponentId,
  PublicStatusEvent,
  PublicStatusHistory,
  PublicStatusLevel,
  PublicStatusRealtime,
  PublicStatusSampleCell,
  PublicStatusSnapshot,
} from "@bakagame/shared";

// ==================== 服务状态页的假数据 ====================
// 只供 Storybook 与截图使用。时间轴以故事运行时刻为准（页面按 generatedAt 对齐格子），
// 起伏用固定种子生成，每次截图形状一致。

export type StatusScenario = "healthy" | "incident" | "unmonitored";

/** 有延迟口径的组件与它们的基准毫秒数；其余是进程内组件，没有延迟。 */
const LATENCY_BASE: Partial<Record<PublicStatusComponentId, number>> = {
  frontend: 84,
  bangumi: 212,
  qqmusic: 96,
  netease: 138,
  qq: 61,
  search: 4,
};

/** 「未接入监测」场景里没有结论的组件：线上未配外部监测时的样子。 */
const UNMONITORED: readonly PublicStatusComponentId[] = [
  "frontend",
  "bangumi",
  "qqmusic",
  "netease",
  "qq",
];

const seeded = (seed: number) => () => {
  seed = (seed * 1_664_525 + 1_013_904_223) % 4_294_967_296;
  return seed / 4_294_967_296;
};

const beijingDay = (time: number): string =>
  new Date(time + 8 * 3_600_000).toISOString().slice(0, 10);

/** 某组件在第 `index` 格（左旧右新，共 `count` 格）的等级。 */
const levelAt = (
  scenario: StatusScenario,
  id: PublicStatusComponentId,
  index: number,
  count: number
): PublicStatusLevel => {
  if (scenario === "unmonitored" && UNMONITORED.includes(id)) return "unknown";
  if (scenario === "incident") {
    if (id === "qqmusic" && index >= count - 7) return "degraded";
    if (id === "search" && index >= count - 2) return "degraded";
  }
  // 两组件各有一小段历史抖动：可用率不是清一色的 100%。
  if (id === "netease" && index === Math.floor(count * 0.42)) return "degraded";
  if (id === "bangumi" && index === Math.floor(count * 0.71)) return "degraded";
  return "operational";
};

export function statusFixture(scenario: StatusScenario, now = Date.now()) {
  const interval = PUBLIC_STATUS_SAMPLE_INTERVAL_MS;
  const count = Math.round(PUBLIC_STATUS_REALTIME_WINDOW_MS / interval);
  const last = Math.floor(now / interval) * interval;

  const realtime: PublicStatusRealtime = {
    intervalMs: interval,
    windowMs: PUBLIC_STATUS_REALTIME_WINDOW_MS,
    generatedAt: now,
    entries: PUBLIC_STATUS_COMPONENT_IDS.map((id, componentIndex) => {
      const random = seeded(componentIndex + 7);
      const base = LATENCY_BASE[id];
      const cells: PublicStatusSampleCell[] = [];
      let operational = 0;
      let determinate = 0;
      for (let index = 0; index < count; index += 1) {
        // 采样器启动前的一小段没有样本：条带最左侧留出矮桩。
        if (index < 6) continue;
        const level = levelAt(scenario, id, index, count);
        const wave = Math.sin(index / 9 + componentIndex) * 0.18 + (random() - 0.5) * 0.22;
        const latencyMs =
          base !== undefined && level === "operational"
            ? Math.max(1, Math.round(base * (1 + wave)))
            : null;
        if (level !== "unknown") determinate += 1;
        if (level === "operational") operational += 1;
        cells.push({
          start: last - (count - 1 - index) * interval,
          total: 1,
          ratio: level === "unknown" ? null : level === "operational" ? 1 : 0,
          level,
          latencyMs,
        });
      }
      return { id, uptime: determinate > 0 ? operational / determinate : null, cells };
    }),
  };

  const days = Array.from({ length: PUBLIC_STATUS_HISTORY_DAYS }, (_, index) =>
    beijingDay(now - (PUBLIC_STATUS_HISTORY_DAYS - 1 - index) * 86_400_000)
  );
  const history: PublicStatusHistory = {
    days: PUBLIC_STATUS_HISTORY_DAYS,
    generatedAt: now,
    entries: PUBLIC_STATUS_COMPONENT_IDS.map((id) => {
      let operational = 0;
      let determinate = 0;
      const cells: PublicStatusCell[] = days.map((day, index) => {
        // 状态页上线前的日子没有样本。
        if (index < 9) return { day, total: 0, ratio: null, level: "unknown" };
        const level = levelAt(scenario, id, index, days.length);
        const total = 480;
        const ratio = level === "unknown" ? null : level === "operational" ? 1 : 0.9625;
        if (ratio !== null) {
          determinate += total;
          operational += ratio * total;
        }
        return { day, total, ratio, level };
      });
      return {
        id,
        cells,
        uptime: [
          {
            days: PUBLIC_STATUS_HISTORY_DAYS,
            ratio: determinate ? operational / determinate : null,
          },
        ],
      };
    }),
  };

  const levelNow = (id: PublicStatusComponentId) => levelAt(scenario, id, count - 1, count);
  const components = PUBLIC_STATUS_COMPONENT_IDS.map((id) => {
    const level = levelNow(id);
    const base = LATENCY_BASE[id];
    return {
      id,
      level,
      latencyMs: base !== undefined && level === "operational" ? Math.round(base * 1.04) : null,
    };
  });
  const snapshot: PublicStatusSnapshot = {
    observedAt: now,
    version: "V1.12.0（1362300）",
    level: components.some((component) => component.level === "degraded")
      ? "degraded"
      : "operational",
    components,
  };

  const events: PublicStatusEvent[] = [
    ...(scenario === "incident"
      ? [
          {
            id: 12,
            kind: "incident" as const,
            title: "QQ音乐接口请求超时",
            body: "部分猜歌房间拉取歌单失败，已切换到网易云兜底，正在排查上游限流。",
            status: "identified" as const,
            components: ["qqmusic" as const],
            startedAt: last - 6 * interval,
            plannedEndAt: null,
            resolvedAt: null,
            updatedAt: now - 60_000,
          },
          {
            id: 13,
            kind: "maintenance" as const,
            title: "搜索索引重建",
            body: "番剧数据更新后重建搜索索引，期间搜索结果可能不完整。",
            status: "in_progress" as const,
            components: ["search" as const],
            startedAt: last - 2 * interval,
            plannedEndAt: now + 40 * 60_000,
            resolvedAt: null,
            updatedAt: now - 120_000,
          },
        ]
      : []),
    {
      id: 9,
      kind: "maintenance",
      title: "数据库迁移到新实例",
      body: "",
      status: "done",
      components: [],
      startedAt: now - 6 * 86_400_000,
      plannedEndAt: now - 6 * 86_400_000 + 3_600_000,
      resolvedAt: now - 6 * 86_400_000 + 3_000_000,
      updatedAt: now - 6 * 86_400_000 + 3_000_000,
    },
    {
      id: 7,
      kind: "incident",
      title: "网易云音乐登录态失效",
      body: "",
      status: "resolved",
      components: ["netease"],
      startedAt: now - 11 * 86_400_000,
      plannedEndAt: null,
      resolvedAt: now - 11 * 86_400_000 + 1_800_000,
      updatedAt: now - 11 * 86_400_000 + 1_800_000,
    },
  ];

  return { snapshot, realtime, history, events: { generatedAt: now, events } };
}

/**
 * 给故事装上假接口与假实时通道：fetch 按路径回 fixture，WebSocket 连上后推一帧快照。
 * 实时接口按 `roundTripMs` 回来（页面拿它当往返延迟），历史与事件晚一些，看得到骨架与显影；返回还原函数。
 */
export function installStatusFixture(
  fixture: ReturnType<typeof statusFixture> | null,
  roundTripMs = 46
): () => void {
  const delayMs = 420;
  const originalFetch = window.fetch.bind(window);
  const OriginalSocket = window.WebSocket;
  const bodies: Record<string, unknown> = fixture
    ? {
        "/api/status/realtime": fixture.realtime,
        "/api/status/history": fixture.history,
        "/api/status/events": fixture.events,
      }
    : {};

  window.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = input instanceof Request ? input.url : String(input);
    const path = Object.keys(bodies).find((key) => url.includes(key));
    if (!url.includes("/api/status")) return originalFetch(input, init);
    // 读取中的故事：接口永远不回，页面停在骨架。
    if (!path) return new Promise<Response>(() => {});
    await new Promise((resolve) =>
      setTimeout(resolve, path.endsWith("/realtime") ? roundTripMs : delayMs)
    );
    return new Response(JSON.stringify(bodies[path]), {
      headers: { "content-type": "application/json" },
    });
  }) as typeof fetch;

  class StorySocket {
    static readonly OPEN = 1;
    readyState = 0;
    onopen: (() => void) | null = null;
    onmessage: ((event: { data: string }) => void) | null = null;
    onclose: (() => void) | null = null;
    onerror: (() => void) | null = null;
    private timer: ReturnType<typeof setTimeout> | undefined;
    constructor() {
      if (!fixture) return;
      this.timer = setTimeout(() => {
        this.readyState = 1;
        this.onopen?.();
        this.onmessage?.({ data: JSON.stringify(fixture.snapshot) });
      }, delayMs / 2);
    }
    send(): void {}
    close(): void {
      clearTimeout(this.timer);
      this.readyState = 3;
    }
  }
  window.WebSocket = StorySocket as unknown as typeof WebSocket;

  return () => {
    window.fetch = originalFetch;
    window.WebSocket = OriginalSocket;
  };
}
