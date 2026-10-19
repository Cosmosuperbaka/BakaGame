import { mkdir, readdir, writeFile } from "node:fs/promises";
import path from "node:path";

/**
 * 把 `tasks/loadtest/*.json` 的压测报告合成一份自包含 HTML（内联 SVG，不依赖网络）。
 * 用法：`bun run scripts/loadtest/Report.ts [报告目录] [输出文件]`
 */

interface Step {
  index: number;
  players: number;
  pace: number;
  roomsStarted: number;
  livePlayers: number;
  liveConnections: number;
  windowMs: number;
  commandsPerSecond: number;
  errorsPerSecond: number;
  errorRate: number;
  retries?: number;
  egressMbps: number;
  ingressMbps: number;
  wireMbps: number;
  bytesPerPlayerSecond: number;
  framesPerSecond: number;
  allocation: { game: string; seats: number; rooms: number; players: number }[];
  latency: { count: number; p50: number; p95: number; p99: number; max: number };
  target: {
    cores: number;
    rssMb: number;
    heapMb: number;
    lagP50Ms: number;
    lagP95Ms: number;
    lagMaxMs: number;
    samples: number;
  };
  generator: { cores: number; rssMb: number };
  failures: Record<string, number>;
  saturated: string | null;
}

interface Report {
  kind: string;
  mode: string;
  label: string;
  startedAt: number;
  durationMs: number;
  host: Record<string, string | number>;
  config: {
    pace: number;
    mix: Record<string, number>;
    seats: Record<string, number>;
    mbps: number;
    shards?: number;
    cpuProf?: boolean;
    fatSeats?: number;
    latencyP95BudgetMs: number;
    lagP95BudgetMs: number;
    errorRateBudget: number;
  };
  source?: { commit: string; dirty: boolean };
  stopReason: string;
  headline: { saturatingDimension: string; peakThroughput: Record<string, number> | null };
  steps: Step[];
}

const PALETTE = [
  "#2f6f4e",
  "#c2662d",
  "#3a6ea5",
  "#8a4f9d",
  "#1f8a8a",
  "#a33b3b",
  "#6b7a2f",
  "#7a5230",
];

const esc = (value: string): string =>
  value.replace(
    /[&<>"']/g,
    (char) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char] ?? char
  );

const fmt = (value: number, digits = 2): string => {
  if (!Number.isFinite(value)) return "-";
  if (Math.abs(value) >= 1_000) return value.toLocaleString("en-US", { maximumFractionDigits: 0 });
  return value.toFixed(digits);
};

const niceMax = (max: number): number => {
  if (max <= 0) return 1;
  const exponent = Math.floor(Math.log10(max));
  const scale = max / 10 ** exponent;
  const step = scale <= 1 ? 1 : scale <= 2 ? 2 : scale <= 5 ? 5 : 10;
  return step * 10 ** exponent;
};

/** 一张多序列折线图：x 轴固定为玩家数，y 轴取所有序列的最大值。 */
const lineChart = (
  title: string,
  unit: string,
  series: { name: string; points: [number, number][]; marker?: [number, number] | null }[],
  options: { xLabel?: string; logY?: boolean } = {}
): string => {
  const width = 720;
  const height = 300;
  const pad = { left: 62, right: 18, top: 26, bottom: 40 };
  const plotW = width - pad.left - pad.right;
  const plotH = height - pad.top - pad.bottom;
  const all = series.flatMap((item) => item.points);
  if (all.length === 0)
    return `<figure class="chart"><figcaption>${esc(title)}</figcaption><p class="empty">无数据</p></figure>`;
  const xs = all.map(([x]) => x);
  const ys = all.map(([, y]) => y).filter((y) => Number.isFinite(y) && y >= 0);
  const xMin = Math.min(...xs);
  const xMax = Math.max(...xs);
  const yMaxRaw = Math.max(...ys, options.logY ? 1 : 0);
  const yMin = options.logY ? Math.max(0.001, Math.min(...ys.filter((y) => y > 0)) * 0.8) : 0;
  const yTop = options.logY ? yMaxRaw * 1.25 : niceMax(yMaxRaw * 1.1);
  const logY = options.logY && yTop > yMin * 20;
  const project = (x: number, y: number): [number, number] => {
    const px = pad.left + (xMax === xMin ? plotW / 2 : ((x - xMin) / (xMax - xMin)) * plotW);
    const ratio = logY
      ? (Math.log(Math.max(y, yMin)) - Math.log(yMin)) / (Math.log(yTop) - Math.log(yMin))
      : (y - yMin) / (yTop - yMin);
    return [px, pad.top + plotH - Math.min(1, Math.max(0, ratio)) * plotH];
  };
  const ticks = [0, 0.25, 0.5, 0.75, 1]
    .map((fraction) => {
      const value = logY ? yMin * (yTop / yMin) ** fraction : yMin + (yTop - yMin) * fraction;
      const [, py] = project(xMin, value);
      const label =
        value >= 1000
          ? `${Math.round(value / 100) / 10}k`
          : fmt(value, value >= 10 ? 0 : value >= 1 ? 1 : 3);
      return `<line x1="${pad.left}" y1="${py.toFixed(1)}" x2="${width - pad.right}" y2="${py.toFixed(1)}" class="grid"/><text x="${pad.left - 8}" y="${(py + 4).toFixed(1)}" class="tick" text-anchor="end">${label}</text>`;
    })
    .join("");
  const xTicks = (
    xMax === xMin
      ? [xMin]
      : [0, 0.25, 0.5, 0.75, 1].map((fraction) => Math.round(xMin + (xMax - xMin) * fraction))
  )
    .map((value, index, list) => {
      const [px] = project(value, logY ? yMin : 0);
      return `<text x="${px.toFixed(1)}" y="${height - pad.bottom + 18}" class="tick" text-anchor="middle">${list.length === 1 || index % 2 === 0 ? value.toLocaleString("en-US") : ""}</text>`;
    })
    .join("");
  const bodies = series
    .map((item, index) => {
      const color = PALETTE[index % PALETTE.length]!;
      const sorted = [...item.points].sort((a, b) => a[0] - b[0]);
      const d = sorted
        .map(([x, y], position) => {
          const [px, py] = project(x, y);
          return `${position === 0 ? "M" : "L"}${px.toFixed(1)} ${py.toFixed(1)}`;
        })
        .join(" ");
      const dots = sorted
        .map(([x, y]) => {
          const [px, py] = project(x, y);
          return `<circle cx="${px.toFixed(1)}" cy="${py.toFixed(1)}" r="3.2" fill="${color}"><title>${esc(item.name)} · ${x} 玩家 · ${fmt(y)}${unit}</title></circle>`;
        })
        .join("");
      const wall = item.marker
        ? `<g>${(() => {
            const [px, py] = project(item.marker[0], item.marker[1]);
            return `<circle cx="${px.toFixed(1)}" cy="${py.toFixed(1)}" r="6" fill="none" stroke="${color}" stroke-width="2"/><line x1="${px.toFixed(1)}" y1="${py.toFixed(1)}" x2="${px.toFixed(1)}" y2="${(height - pad.bottom).toFixed(1)}" stroke="${color}" stroke-dasharray="4 3" opacity="0.6"/>`;
          })()}</g>`
        : "";
      return `<path d="${d}" fill="none" stroke="${color}" stroke-width="2"/>${dots}${wall}`;
    })
    .join("");
  const legend = series
    .map(
      (item, index) =>
        `<span class="key"><i style="background:${PALETTE[index % PALETTE.length]}"></i>${esc(item.name)}</span>`
    )
    .join("");
  return (
    `<figure class="chart"><figcaption>${esc(title)} <em>${esc(unit)}</em>${options.xLabel ? ` <span class="axis">x: ${esc(options.xLabel)}</span>` : ""}</figcaption>` +
    `<svg viewBox="0 0 ${width} ${height}" role="img" aria-label="${esc(title)}">${ticks}${xTicks}${bodies}</svg>` +
    `<div class="legend">${legend}</div><p class="note">圈出的是该序列触发饱和判定的那一跳。</p></figure>`
  );
};

const load = async (dir: string): Promise<Report[]> => {
  const reports: Report[] = [];
  for (const entry of await readdir(dir)) {
    if (!entry.endsWith(".json")) continue;
    try {
      const doc = (await new Response(Bun.file(path.join(dir, entry))).json()) as Report;
      if (doc.kind === "bakagame-loadtest" && Array.isArray(doc.steps) && doc.steps.length > 0)
        reports.push(doc);
    } catch {
      /* 跳过非报告 JSON */
    }
  }
  return reports.sort((a, b) => a.startedAt - b.startedAt);
};

const stepRows = (report: Report): string =>
  report.steps
    .map(
      (step) =>
        `<tr>` +
        `<td>${step.index}</td><td>${step.players}</td><td>${step.livePlayers}</td><td>${step.roomsStarted}</td><td>${fmt(step.windowMs / 1000, 0)}</td>` +
        `<td>${fmt(step.commandsPerSecond)}</td><td>${fmt(step.wireMbps, 2)}</td><td>${fmt(step.egressMbps, 2)}</td>` +
        `<td>${step.bytesPerPlayerSecond}</td><td>${fmt(step.framesPerSecond)}</td>` +
        `<td>${fmt(step.framesPerSecond / Math.max(1, step.roomsStarted), 1)}</td>` +
        `<td>${fmt(step.target.cores)}</td><td>${step.target.rssMb}</td><td>${step.target.heapMb}</td>` +
        `<td>${fmt(step.latency.p50, 1)}</td><td>${fmt(step.latency.p95, 1)}</td><td>${fmt(step.latency.p99, 1)}</td>` +
        `<td>${fmt(step.target.lagP95Ms, 0)}</td><td>${(step.errorRate * 100).toFixed(2)}%</td><td>${step.retries ?? 0}</td>` +
        `<td>${fmt(step.generator.cores)}</td><td>${step.saturated ? `<b>${esc(step.saturated)}</b>` : ""}</td></tr>`
    )
    .join("");

const pick = (report: Report, pickName: (step: Step) => number): [number, number][] =>
  report.steps.map((step) => [step.livePlayers, pickName(step)] as [number, number]);

const wall = (report: Report, pickName: (step: Step) => number): [number, number] | null => {
  const hit = report.steps.find(
    (step) =>
      step.saturated &&
      step.saturated !== "max-steps" &&
      step.saturated !== "iterations" &&
      step.saturated !== "pace-sweep"
  );
  return hit ? [hit.livePlayers, pickName(hit)] : null;
};

/** 一次运行的「合规上限」：最后一个没有触发饱和判定的跳；全都没触发就是最后一跳。 */
const compliantTop = (report: Report): Step => {
  const clean = report.steps.filter(
    (step) =>
      !step.saturated ||
      step.saturated === "max-steps" ||
      step.saturated === "iterations" ||
      step.saturated === "pace-sweep" ||
      step.saturated === "max-players" ||
      step.saturated === "found"
  );
  return clean.length ? clean[clean.length - 1]! : report.steps[report.steps.length - 1]!;
};

/** 结论只从数据里拼，不写没有测过的话。 */
const mixText = (report: Report): string => {
  const entries = Object.entries(report.config.mix).filter(([, share]) => (share ?? 0) > 0.001);
  if (entries.length === 1) return `纯 ${entries[0]![0]}`;
  return entries.map(([game, share]) => `${game} ${Math.round(share * 100)}%`).join("/");
};

/** 开局不足的计划 80% 的跳是发压侧撞了号，带宽读数不能用；二分只采信干净的跳。 */
const capUnder = (report: Report): Step[] =>
  report.steps.filter(
    (step) => step.saturated !== "rooms-invalid" && step.wireMbps <= report.config.mbps
  );

const capOver = (report: Report): Step[] =>
  report.steps.filter(
    (step) => step.saturated !== "rooms-invalid" && step.wireMbps > report.config.mbps
  );

/** 单游戏成本探针：标签里的 `S-<游戏>-p<节奏>` 段，允许前面带战役前缀。 */
const isUnitRun = (report: Report): boolean => /(?:^|-)S-/.test(report.label);
const unitGame = (report: Report): string =>
  report.label.match(/(?:^|-)S-([a-z]+)-/)?.[1] ?? report.label;

const isProbeRun = (report: Report): boolean => /(?:^|-)N-\d/.test(report.label);

/** 剖面跳：只跑一跳、为的是采被测进程的 CPU 时间归属，不能当容量读数参与对比。 */
const isProfilingRun = (report: Report): boolean => report.config.cpuProf === true;

/** 撞预算而停 = 这一跳真的把某个维度压到了边界；被阶梯参数截断则只是没测完。 */
const SATURATED_BY_BUDGET = new Set([
  "ack-latency",
  "event-loop",
  "errors",
  "rooms",
  "cpu",
  "plateau",
  "bandwidth-cap",
]);

/** 能当容量读数用的爬坡：跳数够（至少 3 跳才谈得上拐点），或确实撞到预算。冒烟跳与截断跳都不算。 */
const isCapacityRun = (report: Report): boolean =>
  report.mode === "ramp" &&
  !isUnitRun(report) &&
  !isProbeRun(report) &&
  !isProfilingRun(report) &&
  (report.steps.length >= 3 || SATURATED_BY_BUDGET.has(report.stopReason));

/** 被测进程数：老报告没写这个字段，按单进程读。 */
const shardsOf = (report: Report): number =>
  Math.max(1, Math.round(Number(report.config.shards ?? 1)));

/** 报告来自哪台机器：本机与生产机混在一份报告里时必须能分开。 */
const machineOf = (report: Report): string => String(report.host.machine ?? "").trim();

/** 硬件指纹：`--machine` 是后来才有的参数，老报告没标过，只能靠指纹认出是同一台机器。 */
const machineKey = (report: Report): string =>
  `${String(report.host.cpuModel ?? "").trim()}|${String(report.host.logicalCpus ?? "")}|${String(
    report.host.platform ?? ""
  )}`;

/** 一套运行里的机器索引：按指纹归并，展示名优先用运行自己标的。 */
interface MachineIndex {
  keys: string[];
  multi: boolean;
  label: (report: Report) => string;
  host: (key: string) => Report;
}
const machineIndex = (reports: readonly Report[]): MachineIndex => {
  const names = new Map<string, string>();
  const sample = new Map<string, Report>();
  for (const report of reports) {
    const key = machineKey(report);
    // 传入顺序按时间升序，一路覆盖后每台机器留下的是最近一次运行。
    sample.set(key, report);
    const named = machineOf(report);
    if (named) names.set(key, named);
    else if (!names.has(key)) names.set(key, "");
  }
  const keys = [...sample.keys()];
  return {
    keys,
    multi: keys.length > 1,
    label: (report) =>
      names.get(machineKey(report)) || String(report.host.cpuModel ?? "").trim() || "未标机器",
    host: (key) => sample.get(key)!,
  };
};

/** 整套运行里是否混了机器 / 混了进程数；没混就不往标签里加噪声。 */
interface RunLabels {
  machines: MachineIndex;
  shards: boolean;
}
const runLabels = (reports: readonly Report[]): RunLabels => ({
  machines: machineIndex(reports),
  shards: reports.some((report) => shardsOf(report) > 1),
});

const runTag = (report: Report, labels: RunLabels): string => {
  const parts: string[] = [];
  if (labels.machines.multi) parts.push(labels.machines.label(report));
  if (labels.shards) parts.push(`${shardsOf(report)} 进程`);
  return parts.length ? ` · ${parts.join(" · ")}` : "";
};

/** 该运行代表的容量点：带宽二分取最后一个没超预算的跳，其余取最后一个没触发饱和判定的跳。 */
const capacityOf = (report: Report): Step => {
  if (report.mode !== "cap") return compliantTop(report);
  const under = capUnder(report);
  return under.length
    ? under.reduce((acc, step) => (step.livePlayers > acc.livePlayers ? step : acc))
    : report.steps[report.steps.length - 1]!;
};

/** 进程数只是开了几个事件循环，跨运行真正可比的是每核吞吐。 */
const perCoreCommands = (step: Step): number =>
  step.target.cores > 0.01 ? step.commandsPerSecond / step.target.cores : 0;

/** 可玩性口径：一次按下到一次回应的 P95 不超过这个毫秒数，才叫「服务得过来」。 */
const SLO_ACK_P95_MS = 150;

/**
 * 爬坡把容量量化到了阶梯上：同一份代码、不同起点，「最后一个没饱和的跳」会差出一倍。
 * 在相邻两跳之间按 ack P95 线性插值，拿到的才是与阶梯无关的容量点。
 */
const atSlo = (report: Report): Step | null => {
  const steps = report.steps.filter((step) => step.saturated !== "rooms-invalid");
  for (let index = 1; index < steps.length; index += 1) {
    const low = steps[index - 1]!;
    const high = steps[index]!;
    if (low.latency.p95 <= SLO_ACK_P95_MS && high.latency.p95 >= SLO_ACK_P95_MS) {
      const t =
        (SLO_ACK_P95_MS - low.latency.p95) / Math.max(1e-6, high.latency.p95 - low.latency.p95);
      const mix = (a: number, b: number): number => a + (b - a) * t;
      return {
        ...high,
        livePlayers: Math.round(mix(low.livePlayers, high.livePlayers)),
        commandsPerSecond: mix(low.commandsPerSecond, high.commandsPerSecond),
        wireMbps: mix(low.wireMbps, high.wireMbps),
        latency: { ...high.latency, p95: SLO_ACK_P95_MS },
        target: {
          ...high.target,
          cores: mix(low.target.cores, high.target.cores),
          rssMb: Math.round(mix(low.target.rssMb, high.target.rssMb)),
          lagP95Ms: mix(low.target.lagP95Ms, high.target.lagP95Ms),
        },
      };
    }
  }
  return null;
};

/** 同一配置位上谁代表该配置：剖面跳不能顶掉容量跳，其余新的赢。 */
const shouldReplace = (current: Report | undefined, next: Report): boolean => {
  if (!current) return true;
  if (isProfilingRun(current) !== isProfilingRun(next)) return !isProfilingRun(next);
  return next.startedAt >= current.startedAt;
};

/** 同一口径重复跑过就只留最近一次：结论里每个配置说一遍，历史读数仍留在摘要与逐跳表。 */
const latestPerConfig = (reports: Report[]): Report[] =>
  [
    ...reports.reduce((acc, report) => {
      const key = [
        machineKey(report),
        report.mode,
        mixText(report),
        report.config.pace,
        shardsOf(report),
        report.config.mbps,
        report.config.fatSeats ?? 0,
      ].join("#|");
      if (shouldReplace(acc.get(key), report)) acc.set(key, report);
      return acc;
    }, new Map<string, Report>()),
  ]
    .map(([, report]) => report)
    .sort((a, b) => a.startedAt - b.startedAt);

const conclusion = (reports: Report[]): string => {
  const lines: string[] = [];
  const picked = latestPerConfig(reports);
  const labels = runLabels(reports);
  const tag = (report: Report): string => runTag(report, labels);
  const ramps = picked.filter(isCapacityRun);
  for (const report of ramps) {
    const top = compliantTop(report);
    const slo = atSlo(report);
    const truncatedByLadder =
      report.stopReason === "max-steps" || report.stopReason === "max-players";
    lines.push(
      `<b>pace ${report.config.pace}、${esc(mixText(report))}${esc(
        tag(report)
      )}</b>：ack P95 ≤ ${SLO_ACK_P95_MS} ms 这条延迟线上可服务 <b>${
        slo
          ? `${slo.livePlayers} 名（${fmt(slo.commandsPerSecond)} 指令/秒、${fmt(
              perCoreCommands(slo)
            )} 指令/秒·核、${fmt(slo.wireMbps)} Mbps、${fmt(slo.target.cores)} 核）`
          : truncatedByLadder
            ? `至少 ${top.livePlayers} 名（阶梯在 ${report.stopReason} 处截断，最后一跳 ack P95 还没到 ${SLO_ACK_P95_MS} ms，只说明容量下界）`
            : "本次阶梯没跨过该延迟线"
      }</b>；最后一个未判饱和的跳是 ${top.livePlayers} 名（${
        top.roomsStarted
      } 个房间、${fmt(top.commandsPerSecond)} 指令/秒、带宽 ${fmt(
        top.wireMbps
      )} Mbps、CPU ${fmt(top.target.cores)} 核、RSS ${top.target.rssMb} MB、ack P95 ${fmt(
        top.latency.p95,
        1
      )} ms、事件环 P95 ${fmt(top.target.lagP95Ms, 0)} ms）；本次停止于 <code>${esc(
        report.stopReason
      )}</code>。`
    );
  }
  for (const report of picked.filter((item) => item.mode === "cap")) {
    const over = capOver(report);
    const top = capacityOf(report);
    const bracket = over.length
      ? `，实测最近超限点是 ${over.reduce((acc, s) => (s.livePlayers < acc.livePlayers ? s : acc)).livePlayers} 名`
      : "";
    lines.push(
      `<b>带宽钉在 ${report.config.mbps} Mbps、pace ${report.config.pace}、${esc(mixText(report))}${esc(tag(report))}</b>：可承载 <b>${top.livePlayers}</b> 名玩家 = ${fmt(top.commandsPerSecond)} 指令/秒（该跳 ${fmt(top.wireMbps)} Mbps${bracket}），此时 CPU ${fmt(top.target.cores)} 核、RSS ${top.target.rssMb} MB、ack P95 ${fmt(top.latency.p95, 1)} ms、事件环 P95 ${fmt(top.target.lagP95Ms, 0)} ms（二分 ${report.steps.length} 跳，判定 <code>${esc(report.stopReason)}</code>）。`
    );
  }
  for (const report of picked.filter((item) => item.mode === "fat")) {
    const seats = Math.max(...Object.values(report.config.seats));
    const sweep = report.steps
      .map(
        (step) =>
          `pace ${step.pace} → ${fmt(step.wireMbps)} Mbps / ${fmt(step.target.cores)} 核 / ${fmt(step.latency.p95, 0)} ms`
      )
      .join("；");
    lines.push(
      `<b>单个 ${seats} 人大房间${esc(tag(report))}</b>：每次房间状态变化都要扇出给全部 ${seats} 条连接，所以它是带宽与事件环的最坏情形。实测同一间房按节奏扫一遍：${sweep}（带宽 Mbps / CPU 核 / ack P95 ms）。文档基线（<code>Agents/Deployment.md</code> §6 容量与带宽）是单房 12 变化/秒下 150 人压进 6 Mbps 出口，可与本行对表。`
    );
  }
  const probes = reports.filter(
    (report) => report.mode === "ramp" && isProbeRun(report) && report.steps.length > 0
  );
  if (probes.length > 0) {
    const sweep = probes
      .map(
        (report) =>
          `${report.steps[report.steps.length - 1]!.players} 名 → ${fmt(report.steps[report.steps.length - 1]!.commandsPerSecond)} 指令/秒 / ${fmt(report.steps[report.steps.length - 1]!.wireMbps)} Mbps / ${fmt(report.steps[report.steps.length - 1]!.target.cores)} 核 / ack P95 ${fmt(report.steps[report.steps.length - 1]!.latency.p95, 0)} ms`
      )
      .join("；");
    lines.push(
      `单跳探针（每次换成全新被测进程，跳开上一步遗留房间对房间号的占用）：${sweep}。爬坡跑到中途停住时，这些点补出同一台机器在更高玩家数上的读数。`
    );
  }
  const units = reports.filter(isUnitRun);
  if (units.length > 0) {
    lines.push("三游戏人均成本（用于任意混合比例外推）：见下表「按游戏拆分」。");
  }
  return `<ul>${lines.map((line) => `<li>${line}</li>`).join("")}</ul>`;
};

const unitTable = (reports: Report[]): string => {
  const rows = reports.filter(isUnitRun).map((report) => {
    const step = report.steps[report.steps.length - 1]!;
    const game = unitGame(report);
    return (
      `<tr><td>${esc(game)}</td><td>${report.config.pace}</td><td>${step.livePlayers}</td><td>${fmt(step.commandsPerSecond)}</td>` +
      `<td>${fmt(step.commandsPerSecond / Math.max(1, step.livePlayers), 3)}</td><td>${fmt((step.wireMbps * 1000) / Math.max(1, step.livePlayers), 1)}</td>` +
      `<td>${step.bytesPerPlayerSecond}</td><td>${fmt(step.framesPerSecond / Math.max(1, step.livePlayers), 2)}</td>` +
      `<td>${fmt(step.target.cores / Math.max(1, step.livePlayers), 4)}</td><td>${Math.round(step.target.rssMb / Math.max(1, step.liveConnections))}</td></tr>`
    );
  });
  if (rows.length === 0) return "";
  return (
    `<section><h2>按游戏拆分</h2><p class="meta">同机同节奏下各跑 600 人：人均指令、人均带宽、人均 CPU 与每人常驻内存，混合比例按下式加权即可外推任意配比。</p>` +
    `<div class="scroll"><table><thead><tr><th>游戏</th><th>pace</th><th>在线</th><th>指令/秒</th><th>人均指令/秒</th><th>人均带宽 kbps</th><th>人均下行字节/秒</th><th>人均帧/秒</th><th>人均 CPU 核</th><th>每人 RSS KB</th></tr></thead><tbody>${rows.join("")}</tbody></table></div></section>`
  );
};

/** 全部选择器都挂在 `.ltrep` 下：这份 CSS 也要能作为片段嵌进别的页面，不能漏出去改宿主样式。 */
const STYLES = `
.ltrep{box-sizing:border-box;color:#16211c;font:15px/1.65 "Noto Sans SC","PingFang SC","Microsoft YaHei",system-ui,sans-serif}
.ltrep *{box-sizing:border-box}
.ltrep h1{font-size:26px;margin:0 0 6px}
.ltrep h2{font-size:19px;margin:26px 0 12px;padding-bottom:6px;border-bottom:2px solid #d9e2dd}
.ltrep h3{font-size:15px;margin:0 0 4px}
.ltrep section{margin-bottom:8px}
.ltrep p{margin:0 0 10px}
.ltrep p.lede{color:#5d6b64;margin:0 0 20px}
.ltrep .cards{display:grid;grid-template-columns:repeat(auto-fill,minmax(240px,1fr));gap:12px}
.ltrep .card{background:#fff;border:1px solid #d9e2dd;border-radius:10px;padding:13px 15px}
.ltrep .card .mode{color:#5d6b64;font-size:12px;margin:0 0 10px}
.ltrep .card dl{display:grid;grid-template-columns:1fr 1fr;gap:6px 12px;margin:0}
.ltrep .card dl div{display:flex;flex-direction:column}
.ltrep .card dt{font-size:11px;color:#5d6b64}
.ltrep .card dd{margin:0;font-variant-numeric:tabular-nums;font-weight:600}
.ltrep .card dd span{font-weight:400;color:#5d6b64;font-size:11px;margin-left:4px}
.ltrep .chart{background:#fff;border:1px solid #d9e2dd;border-radius:10px;padding:12px 14px 8px;margin:0 0 14px}
.ltrep .chart figcaption{font-weight:600;font-size:14px;margin-bottom:6px}
.ltrep .chart figcaption em{color:#5d6b64;font-style:normal;font-weight:400}
.ltrep .chart .axis{color:#5d6b64;font-weight:400;font-size:12px}
.ltrep .chart svg{width:100%;height:auto;display:block}
.ltrep .grid{stroke:#d9e2dd;stroke-width:1}
.ltrep .tick{fill:#5d6b64;font-size:11px}
.ltrep .legend{display:flex;flex-wrap:wrap;gap:10px;margin:6px 0 0;font-size:12px;color:#5d6b64}
.ltrep .legend .key{display:inline-flex;align-items:center;gap:5px}
.ltrep .legend i{width:12px;height:3px;display:inline-block;border-radius:2px}
.ltrep .note{color:#5d6b64;font-size:11px;margin:6px 0 2px}
.ltrep .run,.ltrep .concl{background:#fff;border:1px solid #d9e2dd;border-radius:10px;padding:14px 16px;margin:0 0 14px}
.ltrep .concl{background:#f2f8f4;border-color:#cfe3d6}
.ltrep .meta{color:#5d6b64;font-size:12px;margin:0 0 10px}
.ltrep .scroll{overflow-x:auto}
.ltrep table{border-collapse:collapse;width:100%;font-size:12px;font-variant-numeric:tabular-nums}
.ltrep th,.ltrep td{padding:4px 7px;border-bottom:1px solid #d9e2dd;text-align:right;white-space:nowrap}
.ltrep th:first-child,.ltrep td:first-child{text-align:left}
.ltrep tbody tr:hover{background:#f1f6f2}
.ltrep tbody tr.slo{background:#eaf3ec}
.ltrep tbody tr.slo th{color:#1f5b3d}
.ltrep ul{margin:8px 0 0;padding-left:20px}
.ltrep code{background:#eef3ef;padding:1px 5px;border-radius:4px;font-size:12px}
.ltrep .limits{background:#fff8ec;border:1px solid #ecd9ae;border-radius:10px;padding:14px 16px}
`;

/** 同一带宽预算下，不同游戏占比各自能装多少人——这条轴就是用户可调的 mix。 */
const capMatrix = (reports: Report[]): string => {
  const labels = runLabels(reports);
  const groups = new Map<string, Report[]>();
  for (const report of reports.filter((item) => item.mode === "cap")) {
    const key = [machineKey(report), shardsOf(report), report.config.pace, report.config.mbps].join(
      "#|"
    );
    groups.set(key, [...(groups.get(key) ?? []), report]);
  }
  const tables = [...groups.entries()]
    .filter(([, items]) => items.length >= 2)
    .map(([key, items]) => {
      const [, shards, pace, mbps] = key.split("#|");
      const head = items[0]!;
      const best = items.map(capacityOf);
      const row = (label: string, pickName: (step: Step) => string) =>
        `<tr><th>${esc(label)}</th>${items.map((_, index) => `<td>${pickName(best[index]!)}</td>`).join("")}</tr>`;
      return (
        `<p class="meta">${labels.machines.multi ? `${esc(labels.machines.label(head))} · ` : ""}${
          labels.shards ? `${esc(shards!)} 进程 · ` : ""
        }pace ${esc(pace!)}、出口预算 ${esc(mbps!)} Mbps</p>` +
        `<div class="scroll"><table><thead><tr><th></th>${items.map((report) => `<th>${esc(mixText(report))}</th>`).join("")}</tr></thead><tbody>` +
        row("在线玩家", (step) => `<b>${step.livePlayers}</b>`) +
        row("房间", (step) => `${step.roomsStarted}`) +
        row("指令/秒", (step) => fmt(step.commandsPerSecond)) +
        row("带宽 Mbps", (step) => fmt(step.wireMbps)) +
        row("人均下行 字节/秒", (step) => `${step.bytesPerPlayerSecond}`) +
        row("CPU 核", (step) => fmt(step.target.cores)) +
        row("RSS MB", (step) => `${step.target.rssMb}`) +
        row("ack P95 ms", (step) => fmt(step.latency.p95, 1)) +
        row("事件环 P95 ms", (step) => fmt(step.target.lagP95Ms, 0)) +
        `</tbody></table></div>`
      );
    });
  if (tables.length === 0) return "";
  return `<section><h2>占比对承载量的影响</h2><p class="meta">同一台机器、同一个带宽预算下按游戏独占跑满，列与列的差就是混合比例能带来的容量差；任意配比用「按游戏拆分」的人均成本加权即可外推。</p>${tables.join("")}</section>`;
};

/** 只换 --shards 的同口径运行排成一行：这张表就是多进程扩展曲线。 */
const shardScaling = (reports: Report[]): string => {
  const labels = runLabels(reports);
  const groups = new Map<string, Report[]>();
  for (const report of reports.filter(
    (item) =>
      !isUnitRun(item) && !isProbeRun(item) && !isProfilingRun(item) && item.steps.length > 0
  )) {
    const key = [
      machineKey(report),
      report.mode,
      mixText(report),
      report.config.pace,
      report.mode === "cap" ? report.config.mbps : 0,
    ].join("#|");
    groups.set(key, [...(groups.get(key) ?? []), report]);
  }
  const tables = [...groups.values()]
    .map((items) =>
      [
        ...items.reduce((acc, report) => {
          const shards = shardsOf(report);
          if (shouldReplace(acc.get(shards), report)) acc.set(shards, report);
          return acc;
        }, new Map<number, Report>()),
      ]
        .map(([, report]) => report)
        .sort((a, b) => shardsOf(a) - shardsOf(b))
    )
    .filter((items) => items.length >= 2)
    .map((items) => {
      const head = items[0]!;
      const best = items.map(capacityOf);
      const row = (label: string, cell: (step: Step, index: number) => string) =>
        `<tr><th>${esc(label)}</th>${items
          .map((_, index) => `<td>${cell(best[index]!, index)}</td>`)
          .join("")}</tr>`;
      const slo = items.map(atSlo);
      const sloIndex = slo.findIndex((step) => step !== null);
      const hasSlo = sloIndex >= 0;
      const sloBase = hasSlo ? slo[sloIndex]!.livePlayers : 1;
      const sloBaseShards = hasSlo ? shardsOf(items[sloIndex]!) : 1;
      const sloRow = (label: string, cellFn: (step: Step, index: number) => string) =>
        `<tr class="slo"><th>ack P95≤${SLO_ACK_P95_MS}ms：${esc(label)}</th>${slo
          .map((step, index) => `<td>${step ? cellFn(step, index) : "未达"}</td>`)
          .join("")}</tr>`;
      return (
        `<p class="meta">${esc(labels.machines.label(head))} · ${esc(mixText(head))} · ${esc(
          head.mode
        )} · pace ${head.config.pace}${
          head.mode === "cap" ? ` · 预算 ${head.config.mbps} Mbps` : ""
        }</p>` +
        `<div class="scroll"><table><thead><tr><th></th>${items
          .map((report) => `<th>${shardsOf(report)} 进程</th>`)
          .join("")}</tr></thead><tbody>` +
        (hasSlo
          ? sloRow("在线玩家", (step) => `<b>${step.livePlayers}</b>`) +
            sloRow("相对最少进程", (step) => `${fmt(step.livePlayers / sloBase, 2)}×`) +
            sloRow("扩展效率", (step, index) =>
              fmt(step.livePlayers / sloBase / (shardsOf(items[index]!) / sloBaseShards), 2)
            ) +
            sloRow("指令/秒", (step) => fmt(step.commandsPerSecond)) +
            sloRow("每核指令/秒", (step) => fmt(perCoreCommands(step))) +
            sloRow("每进程玩家", (step, index) =>
              fmt(step.livePlayers / shardsOf(items[index]!), 0)
            )
          : "") +
        row("在线玩家", (step) => `<b>${step.livePlayers}</b>`) +
        row("指令/秒", (step) => fmt(step.commandsPerSecond)) +
        row("每核指令/秒", (step) => fmt(perCoreCommands(step))) +
        row("每进程在线", (step, index) => fmt(step.livePlayers / shardsOf(items[index]!), 0)) +
        row("每进程 RSS MB", (step, index) => fmt(step.target.rssMb / shardsOf(items[index]!), 0)) +
        row("带宽 Mbps", (step) => fmt(step.wireMbps)) +
        row("CPU 合计核", (step) => fmt(step.target.cores)) +
        row("RSS 合计 MB", (step) => `${step.target.rssMb}`) +
        row("房间合计", (step) => `${step.roomsStarted}`) +
        row("ack P95 ms", (step) => fmt(step.latency.p95, 1)) +
        row("事件环 P95 ms", (step) => fmt(step.target.lagP95Ms, 0)) +
        row("该次判定", (_, index) => `<code>${esc(items[index]!.stopReason)}</code>`) +
        `</tbody></table></div>`
      );
    });
  if (tables.length === 0) return "";
  return `<section><h2>多进程分片扩展</h2><p class="meta">一个 Bun 进程只有一个事件循环，一核就是一个进程的天花板；<code>--shards N</code> 起 N 个各有独立端口与房间号段的进程，把玩家摊到 N 份事件循环上。同一进程数跑过多次只留最近一次，一个进程数一列。绿底各行是按 <b>ack P95 ≤ ${SLO_ACK_P95_MS} ms</b> 在相邻两跳之间插出来的容量，「相对最少进程」和「扩展效率」也都算在这条线上——爬坡阶梯在各进程数下不同（起步人数按进程数放大），拿最后一跳的原始读数直接相除会把阶梯差当成扩展性。<b>1.00 = 每加一个进程就多出等量承载</b>。带宽受限（cap）那一组通常跨不过这条延迟线，所以只剩下面的原始读数。</p>${tables.join("")}</section>`;
};

/** 同一口径在本机与生产机上各跑一遍，差值就是「开发机的数字能不能外推」的答案。 */
const machineCompare = (reports: Report[]): string => {
  const labels = runLabels(reports);
  if (!labels.machines.multi) return "";
  const groups = new Map<string, Map<string, Report>>();
  for (const report of reports.filter(
    (item) =>
      !isUnitRun(item) && !isProbeRun(item) && !isProfilingRun(item) && item.steps.length > 0
  )) {
    const key = [
      report.mode,
      mixText(report),
      report.config.pace,
      shardsOf(report),
      report.mode === "cap" ? report.config.mbps : 0,
    ].join("#|");
    const byMachine = groups.get(key) ?? new Map<string, Report>();
    const machine = labels.machines.label(report);
    // 同一台机器上重复跑过同口径就留最后一次，两台的读数才对得齐。
    if (!byMachine.has(machine)) byMachine.set(machine, report);
    else if (report.startedAt > (byMachine.get(machine)?.startedAt ?? 0))
      byMachine.set(machine, report);
    groups.set(key, byMachine);
  }
  const tables = [...groups.values()]
    .filter((byMachine) => byMachine.size >= 2)
    .map((byMachine) => {
      const rows = [...byMachine.entries()];
      const head = rows[0]![1];
      const base = capacityOf(head);
      const cell = (label: string, value: (report: Report, step: Step) => string) =>
        `<tr><th>${esc(label)}</th>${rows
          .map(([, report]) => `<td>${value(report, capacityOf(report))}</td>`)
          .join("")}</tr>`;
      const sloSteps = rows.map(([, report]) => atSlo(report));
      const hasSlo = sloSteps.some((step) => step !== null);
      const sloCell = (label: string, value: (step: Step, index: number) => string) =>
        `<tr class="slo"><th>ack P95≤${SLO_ACK_P95_MS}ms：${esc(label)}</th>${sloSteps
          .map((step, index) => `<td>${step ? value(step, index) : "未达"}</td>`)
          .join("")}</tr>`;
      return (
        `<p class="meta">${esc(head.mode)} · ${esc(mixText(head))} · pace ${head.config.pace} · ${shardsOf(
          head
        )} 进程${head.mode === "cap" ? ` · 预算 ${head.config.mbps} Mbps` : ""}</p>` +
        `<div class="scroll"><table><thead><tr><th></th>${rows
          .map(([machine]) => `<th>${esc(machine)}</th>`)
          .join("")}</tr></thead><tbody>` +
        (hasSlo
          ? sloCell("在线玩家", (step) => `<b>${step.livePlayers}</b>`) +
            sloCell("每进程玩家", (step, index) =>
              fmt(step.livePlayers / shardsOf(rows[index]![1]), 0)
            ) +
            sloCell("指令/秒", (step) => fmt(step.commandsPerSecond)) +
            sloCell("每核指令/秒", (step) => fmt(perCoreCommands(step)))
          : "") +
        cell("在线玩家", (_, step) => `<b>${step.livePlayers}</b>`) +
        cell(
          "相对第一台",
          (_, step) => `${fmt(step.livePlayers / Math.max(1, base.livePlayers), 2)}×`
        ) +
        cell("指令/秒", (_, step) => fmt(step.commandsPerSecond)) +
        cell("每核指令/秒", (_, step) => fmt(perCoreCommands(step))) +
        cell("带宽 Mbps", (_, step) => fmt(step.wireMbps)) +
        cell("CPU 合计核", (_, step) => fmt(step.target.cores)) +
        cell("RSS 合计 MB", (_, step) => `${step.target.rssMb}`) +
        cell("ack P95 ms", (_, step) => fmt(step.latency.p95, 1)) +
        cell("事件环 P95 ms", (_, step) => fmt(step.target.lagP95Ms, 0)) +
        cell("判定", (report) => `<code>${esc(report.stopReason)}</code>`) +
        cell(
          "源码",
          (report) => `<code>${esc(report.source?.commit.slice(0, 8) ?? "未知")}</code>`
        ) +
        `</tbody></table></div>`
      );
    });
  if (tables.length === 0) return "";
  return `<section><h2>机器对表</h2><p class="meta">同一份源码、同一口径，只差硬件。绿底行是两台机器在同一个延迟线（ack P95 ≤ ${SLO_ACK_P95_MS} ms）上的容量：开发机的绝对数字不能按比例外推到生产机，「每核指令/秒」是两台之间大致可比的那一列。</p>${tables.join("")}</section>`;
};

const main = async () => {
  const positional = process.argv.slice(2).filter((arg) => !arg.startsWith("--"));
  const fragment = process.argv.includes("--fragment");
  const brief = process.argv.includes("--brief");
  const dir = path.resolve(positional[0] ?? path.resolve(import.meta.dir, "../../tasks/loadtest"));
  const out = path.resolve(
    positional[1] ?? path.join(dir, fragment ? "fragment.html" : "report.html")
  );
  const reports = await load(dir);
  if (reports.length === 0) {
    console.error(`没有可用报告：${dir}`);
    process.exit(1);
  }

  const labels = runLabels(reports);
  const name = (report: Report): string =>
    `${report.label}（pace ${report.config.pace}${
      report.mode === "cap" ? `，上限 ${report.config.mbps}Mbps` : ""
    }${runTag(report, labels)}）`;
  const series = (list: Report[], pickName: (step: Step) => number) =>
    list.map((report) => ({
      name: name(report),
      points: pick(report, pickName),
      marker: wall(report, pickName),
    }));
  /** 容量曲线按机器分块：单机独占与多进程运行的量级差着一个数量级，画在一张图上只会互相压平。 */
  const chartable = (key: string): Report[] =>
    reports.filter(
      (report) =>
        machineKey(report) === key &&
        !isUnitRun(report) &&
        !isProbeRun(report) &&
        !isProfilingRun(report)
    );
  const machineLines = labels.machines.keys
    .map((key) => {
      const report = labels.machines.host(key);
      const h = report.host;
      return `<p class="meta"><b>${esc(labels.machines.label(report))}</b>：${esc(
        String(h.platform ?? "")
      )} ${esc(String(h.release ?? ""))} · ${esc(String(h.cpuModel ?? ""))} · ${esc(
        String(h.logicalCpus ?? "")
      )} 线程 · ${fmt(Number(h.totalMemoryMb ?? 0) / 1024, 0)} GB 内存 · Bun ${esc(
        String(h.bun ?? "")
      )} · 该机器最后一次运行源码 ${esc(report.source?.commit ?? "未知")}${
        report.source?.dirty ? "（含未提交改动）" : ""
      }</p>`;
    })
    .join("");
  const latest = reports[reports.length - 1]!;

  const summaryCards = reports
    .map((report) => {
      const last = report.steps[report.steps.length - 1]!;
      const top = compliantTop(report);
      const best = report.steps.reduce(
        (acc, step) => (step.commandsPerSecond > acc.commandsPerSecond ? step : acc),
        report.steps[0]!
      );
      const cell = (label: string, value: string, hint = ""): string =>
        `<div><dt>${esc(label)}</dt><dd>${value}${hint ? `<span>${esc(hint)}</span>` : ""}</dd></div>`;
      return (
        `<article class="card"><h3>${esc(name(report))}</h3>` +
        `<p class="mode">${esc(report.mode)} · ${esc(report.stopReason)} · ${new Date(report.startedAt).toISOString().slice(0, 16).replace("T", " ")}${report.source ? ` · 源码 ${esc(report.source.commit)}${report.source.dirty ? "±" : ""}` : ""}</p>` +
        `<dl>` +
        cell(
          report.mode === "cap" ? "合规上限玩家" : "合规末跳玩家",
          `${top.livePlayers}`,
          `${top.roomsStarted} 房`
        ) +
        cell("该跳指令/秒", fmt(top.commandsPerSecond)) +
        cell("该跳带宽", `${fmt(top.wireMbps)} Mbps`) +
        cell("该跳 CPU", `${fmt(top.target.cores)} 核`) +
        cell("该跳 RSS", `${top.target.rssMb} MB`) +
        cell("该跳 ack P95", `${fmt(top.latency.p95, 1)} ms`) +
        cell("该跳环延迟 P95", `${fmt(top.target.lagP95Ms, 0)} ms`) +
        cell("峰值指令/秒", fmt(best.commandsPerSecond), `${best.livePlayers} 玩家`) +
        cell("末跳在线", `${last.livePlayers}`, last.saturated ? `饱和 ${last.saturated}` : "") +
        cell("末跳错误率", `${(last.errorRate * 100).toFixed(2)}%`) +
        cell("末跳生成器", `${fmt(last.generator.cores)} 核`, "同机发压") +
        `</dl></article>`
      );
    })
    .join("");

  const tables = reports
    .map(
      (report) =>
        `<section class="run"><h3>${esc(name(report))} · ${esc(report.mode)} · 判定 ${esc(report.stopReason)}</h3>` +
        `<p class="meta">混合 ${Object.entries(report.config.mix)
          .map(([game, value]) => `${game} ${Math.round((value ?? 0) * 100)}%`)
          .join(" / ")} · 座位 ${Object.entries(report.config.seats)
          .map(([game, value]) => `${game} ${value}`)
          .join(
            " / "
          )} · 预算 ack P95 ${report.config.latencyP95BudgetMs}ms / 事件环 P95 ${report.config.lagP95BudgetMs}ms / 错误率 ${(report.config.errorRateBudget * 100).toFixed(1)}%</p>` +
        `<div class="scroll"><table><thead><tr><th>#</th><th>计划</th><th>在线</th><th>房间</th><th>窗口秒</th><th>指令/秒</th><th>带宽 Mbps</th><th>出向 Mbps</th><th>字节/人/秒</th><th>帧/秒</th><th>帧/房/秒</th><th>CPU 核</th><th>RSS MB</th><th>堆 MB</th><th>P50 ms</th><th>P95 ms</th><th>P99 ms</th><th>环延迟 P95</th><th>错误率</th><th>重试</th><th>生成器核</th><th>饱和</th></tr></thead>` +
        `<tbody>${stepRows(report)}</tbody></table></div></section>`
    )
    .join("");

  const failureNotes = reports
    .map((report) => {
      const merged: Record<string, number> = {};
      report.steps.forEach((step) =>
        Object.entries(step.failures ?? {}).forEach(([key, count]) => {
          merged[key] = (merged[key] ?? 0) + count;
        })
      );
      const top = Object.entries(merged)
        .sort((a, b) => b[1] - a[1])
        .slice(0, 6);
      if (top.length === 0) return "";
      return `<li><b>${esc(report.label)}</b>：${top.map(([key, count]) => `${esc(key)}×${count}`).join("、")}</li>`;
    })
    .filter((line) => !!line)
    .join("\n");

  const chartBlock = (list: Report[]): string => {
    const chart = (
      title: string,
      unit: string,
      pickName: (step: Step) => number,
      logY = true
    ): string => lineChart(title, unit, series(list, pickName), { xLabel: "在线玩家", logY });
    const head =
      chart("在线玩家 → 指令吞吐", "指令/秒", (step) => step.commandsPerSecond) +
      chart("在线玩家 → 线上带宽", "Mbps（含 15% 传输开销）", (step) => step.wireMbps) +
      chart("在线玩家 → 被测进程 CPU", "核", (step) => step.target.cores) +
      chart("在线玩家 → 事件环延迟 P95", "ms", (step) => step.target.lagP95Ms);
    if (brief) return head;
    return (
      head +
      chart("在线玩家 → 指令往返延迟", "ms", (step) => step.latency.p95) +
      chart("在线玩家 → 常驻内存", "MB", (step) => step.target.rssMb, false) +
      chart("在线玩家 → 指令错误率", "%", (step) => step.errorRate * 100, false) +
      chart("在线玩家 → 人均下行字节", "字节/人/秒", (step) => step.bytesPerPlayerSecond)
    );
  };
  const charts = labels.machines.keys
    .map((key) => {
      const list = chartable(key);
      if (list.length === 0) return "";
      return `${
        labels.machines.multi ? `<h3>${esc(labels.machines.label(list[0]!))}</h3>` : ""
      }${chartBlock(list)}`;
    })
    .join("");

  const body = `<h1>BakaGame 后端吞吐压测报告</h1>
<p class="lede">实时玩法面（Bun + Elysia，三个游戏 WS 房间）容量与带宽测量 · 生成于 ${new Date().toISOString().slice(0, 16).replace("T", " ")} UTC · ${reports.length} 次运行</p>
<section class="concl">
<h2>结论</h2>
${conclusion(reports)}
</section>
${capMatrix(reports)}
${shardScaling(reports)}
${machineCompare(reports)}
<section>
<h2>测量机</h2>
${machineLines}
<p class="meta">被测进程用与生产相同的 <code>createApp</code> 与三个游戏服务装配线，只把音乐/Bangumi/CEE 数据源换成桩；账号与数据库路由缺席，不影响实时玩法面。握手配额（按客户端地址 64 条在途连接 / 120 条每分钟）在压测进程里放开，否则同机生成器会先被自己的防御挡住。</p>
</section>
<section>
<h2>各次运行摘要</h2>
<div class="cards">${summaryCards}</div>
</section>
<section>
<h2>容量曲线</h2>
${charts}
</section>
${unitTable(reports)}
${
  brief
    ? ""
    : `<section>
<h2>逐跳明细</h2>
${tables}
</section>
${failureNotes ? `<section><h2>失败与重试码</h2><ul>${failureNotes}</ul></section>` : ""}`
}
<section class="limits">
<h2>口径与局限</h2>
<ul>
  <li>「其它硬件满载」在本报告里的口径：不额外注入外部负载，而是把玩家数一路加到某个维度先撑不住——房间启动率、错误率、ack 延迟、事件环延迟、CPU 或吞吐平台期，先到者即为该配置下的满载点；同表给出 CPU、RSS、堆、事件环延迟与生成器自身占用。</li>
  <li>Bun 玩法面是单线程事件循环：一核就是一个进程的天花板，跨核只能靠多进程分片（<code>--shards N</code>），逐进程数的扩展曲线见「多进程分片扩展」。因此「核数没打满」不代表进程空闲，事件环 P95 与 ack P95 一起涨才是真瓶颈信号，本报告把它们当一等指标。</li>
  <li>节奏倍率 <code>pace</code>：房间内所有思考时间的除数。pace 1 接近真人房间，pace 4/24 是压缩节奏的压力模型；同一台机器的承载量在两种口径下不可直接混用。</li>
  <li>饱和判定按先到者：房间启动率 &lt; 80%、错误率 ≥ ${(latest.config.errorRateBudget * 100).toFixed(0)}%、ack P95 ≥ ${latest.config.latencyP95BudgetMs}ms、事件环 P95 ≥ ${latest.config.lagP95BudgetMs}ms、CPU 触顶（需要绑核，Windows 上不可用）、或玩家数继续增长而吞吐与带宽同时平掉。</li>
  <li>报告里另有一条更严的<b>可玩线：ack P95 ≤ ${SLO_ACK_P95_MS} ms</b>（绿底行），它不是判定阈值而是横比口径。爬坡每跳人数成倍跳，所以这个容量是在相邻两跳之间按 ack P95 线性插出来的：用来看趋势、比机器、比进程数，别当成精确到人的额度。</li>
  <li>带宽为应用层统计（服务端发出与收到的 WS 帧字节）× 1.15 传输开销估算，未包含 TCP/TLS 握手与重传；真实公网带宽还要叠加 HTTP 静态资源与音频外链。</li>
  <li>生成器与被测进程同机运行，生成器自身 CPU 已在表内单列，因此高玩家数那几跳读到的上限里混着生成器占用。开发机线程多、绑核隔离（taskset）在 Windows 不可用，CPU 是整进程口径而非单核口径；生产那几跳用 <code>--target-cpuset</code> 把被测钉在一核、生成器钉在另一核，被测侧读数是干净的单核口径，但整机只有两核，所以它的绝对承载量里始终带着生成器的份额，实际可服务人数会比表里的下限更高。</li>
  <li>音频字节不进这条链路：猜歌只下发歌曲 ID 与音频地址，实际音频由客户端直连上游 CDN，所以本报告的带宽不含音频流量。</li>
  <li>生产机那几跳跑在同机临时容器里：内存与核数有硬顶、被测源码是打包时的 HEAD 而不是线上正在跑的那版、线上服务进程另算。所以它回答的是「这台硬件跑这套代码能装多少」，不是「现在这台机器还剩多少余量」。</li>
  <li><b>磁盘与数据库不在热路径上</b>：玩法面全内存，命令→改状态→扇出不碰盘；对局记录进有界内存队列、后台异步落库，积压时丢记录而不是卡事件循环（<code>Server/src/application/GameRecordService.ts</code>）。压测全程磁盘读写接近 0，所以「开发机磁盘快」不会换算成承载量，两台机器的差距是单核算力与可用核数，不是 IO。</li>
  <li>带 <code>--cpu-prof</code> 的那几跳是剖面跳：只跑一跳、采被测进程的 CPU 时间归属，不参与容量与扩展对比，读数在摘要与逐跳表里仍可以看到。</li>
  <li>数据库、账号、上游 API 均未参与（实时玩法面本来就是内存态）；生产环境还有限流、反代与 TLS，单机数字会偏乐观。</li>
</ul>
</section>`;

  const html = fragment
    ? `<div class="ltrep"><style>${STYLES}</style>${body}</div>`
    : `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"/><meta name="viewport" content="width=device-width,initial-scale=1"/>
<title>BakaGame 后端吞吐压测报告</title>
<style>
:root{--bg:#f7f9f7}
body{margin:0;padding:32px 20px 64px;background:#f7f9f7}
main{max-width:1080px;margin:0 auto}
${STYLES}
</style></head><body><main class="ltrep">${body}</main></body></html>`;

  await mkdir(path.dirname(out), { recursive: true });
  await writeFile(out, html, "utf8");
  console.log(`报告页面：${out}（${reports.length} 份运行）`);
};

await main();
