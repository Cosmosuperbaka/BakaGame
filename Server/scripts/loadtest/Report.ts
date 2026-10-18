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

const conclusion = (reports: Report[]): string => {
  const lines: string[] = [];
  const ramps = reports.filter(
    (report) => report.mode === "ramp" && !isUnitRun(report) && !isProbeRun(report)
  );
  for (const report of ramps) {
    const top = compliantTop(report);
    lines.push(
      `<b>pace ${report.config.pace}、${esc(mixText(report))}</b>：合规上限 <b>${top.livePlayers}</b> 名在线玩家（${top.roomsStarted} 个房间、${fmt(top.commandsPerSecond)} 指令/秒、带宽 ${fmt(top.wireMbps)} Mbps、CPU ${fmt(top.target.cores)} 核、RSS ${top.target.rssMb} MB、ack P95 ${fmt(top.latency.p95, 1)} ms、事件环 P95 ${fmt(top.target.lagP95Ms, 0)} ms）；本次停止于 <code>${esc(report.stopReason)}</code>。`
    );
  }
  for (const report of reports.filter((item) => item.mode === "cap")) {
    const under = capUnder(report);
    const over = capOver(report);
    const top = under.length
      ? under.reduce((acc, step) => (step.livePlayers > acc.livePlayers ? step : acc))
      : report.steps[report.steps.length - 1]!;
    const bracket = over.length
      ? `，实测最近超限点是 ${over.reduce((acc, s) => (s.livePlayers < acc.livePlayers ? s : acc)).livePlayers} 名`
      : "";
    lines.push(
      `<b>带宽钉在 ${report.config.mbps} Mbps、pace ${report.config.pace}、${esc(mixText(report))}</b>：可承载 <b>${top.livePlayers}</b> 名玩家 = ${fmt(top.commandsPerSecond)} 指令/秒（该跳 ${fmt(top.wireMbps)} Mbps${bracket}），此时 CPU ${fmt(top.target.cores)} 核、RSS ${top.target.rssMb} MB、ack P95 ${fmt(top.latency.p95, 1)} ms、事件环 P95 ${fmt(top.target.lagP95Ms, 0)} ms（二分 ${report.steps.length} 跳，判定 <code>${esc(report.stopReason)}</code>）。`
    );
  }
  for (const report of reports.filter((item) => item.mode === "fat")) {
    const seats = Math.max(...Object.values(report.config.seats));
    const sweep = report.steps
      .map(
        (step) =>
          `pace ${step.pace} → ${fmt(step.wireMbps)} Mbps / ${fmt(step.target.cores)} 核 / ${fmt(step.latency.p95, 0)} ms`
      )
      .join("；");
    lines.push(
      `<b>单个 ${seats} 人大房间</b>：每次房间状态变化都要扇出给全部 ${seats} 条连接，所以它是带宽与事件环的最坏情形。实测同一间房按节奏扫一遍：${sweep}（带宽 Mbps / CPU 核 / ack P95 ms）。文档基线（<code>Agents/Deployment.md</code> 带宽与容量基线）是单房 12 变化/秒下 150 人压进 6 Mbps 出口，可与本行对表。`
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
.ltrep ul{margin:8px 0 0;padding-left:20px}
.ltrep code{background:#eef3ef;padding:1px 5px;border-radius:4px;font-size:12px}
.ltrep .limits{background:#fff8ec;border:1px solid #ecd9ae;border-radius:10px;padding:14px 16px}
`;

/** 同一带宽预算下，不同游戏占比各自能装多少人——这条轴就是用户可调的 mix。 */
const capMatrix = (reports: Report[]): string => {
  const groups = new Map<string, Report[]>();
  for (const report of reports.filter((item) => item.mode === "cap")) {
    const key = `${report.config.pace}|${report.config.mbps}`;
    groups.set(key, [...(groups.get(key) ?? []), report]);
  }
  const tables = [...groups.entries()]
    .filter(([, items]) => items.length >= 2)
    .map(([key, items]) => {
      const [pace, mbps] = key.split("|");
      const best = items.map((report) => {
        const under = capUnder(report);
        return under.length
          ? under.reduce((acc, step) => (step.livePlayers > acc.livePlayers ? step : acc))
          : report.steps[report.steps.length - 1]!;
      });
      const row = (label: string, pickName: (step: Step) => string) =>
        `<tr><th>${esc(label)}</th>${items.map((_, index) => `<td>${pickName(best[index]!)}</td>`).join("")}</tr>`;
      return (
        `<p class="meta">pace ${esc(pace!)}、出口预算 ${esc(mbps!)} Mbps</p>` +
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

  const name = (report: Report): string =>
    `${report.label}（pace ${report.config.pace}${report.mode === "cap" ? `，上限 ${report.config.mbps}Mbps` : ""}）`;
  const series = (pickName: (step: Step) => number) =>
    reports.map((report) => ({
      name: name(report),
      points: pick(report, pickName),
      marker: wall(report, pickName),
    }));
  const host = reports[reports.length - 1]!.host;
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

  const fullCharts =
    lineChart(
      "在线玩家 → 指令吞吐",
      "指令/秒",
      series((step) => step.commandsPerSecond),
      { xLabel: "在线玩家", logY: true }
    ) +
    lineChart(
      "在线玩家 → 线上带宽",
      "Mbps（含 15% 传输开销）",
      series((step) => step.wireMbps),
      { xLabel: "在线玩家", logY: true }
    ) +
    lineChart(
      "在线玩家 → 被测进程 CPU",
      "核",
      series((step) => step.target.cores),
      { xLabel: "在线玩家", logY: true }
    ) +
    lineChart(
      "在线玩家 → 指令往返延迟",
      "ms",
      series((step) => step.latency.p95),
      { xLabel: "在线玩家", logY: true }
    ) +
    lineChart(
      "在线玩家 → 事件环延迟 P95",
      "ms",
      series((step) => step.target.lagP95Ms),
      { xLabel: "在线玩家", logY: true }
    ) +
    lineChart(
      "在线玩家 → 常驻内存",
      "MB",
      series((step) => step.target.rssMb),
      { xLabel: "在线玩家" }
    ) +
    lineChart(
      "在线玩家 → 指令错误率",
      "%",
      series((step) => step.errorRate * 100),
      { xLabel: "在线玩家" }
    ) +
    lineChart(
      "在线玩家 → 人均下行字节",
      "字节/人/秒",
      series((step) => step.bytesPerPlayerSecond),
      { xLabel: "在线玩家", logY: true }
    );
  const charts = brief
    ? lineChart(
        "在线玩家 → 指令吞吐",
        "指令/秒",
        series((step) => step.commandsPerSecond),
        { xLabel: "在线玩家", logY: true }
      ) +
      lineChart(
        "在线玩家 → 线上带宽",
        "Mbps（含 15% 传输开销）",
        series((step) => step.wireMbps),
        { xLabel: "在线玩家", logY: true }
      ) +
      lineChart(
        "在线玩家 → 被测进程 CPU",
        "核",
        series((step) => step.target.cores),
        { xLabel: "在线玩家", logY: true }
      ) +
      lineChart(
        "在线玩家 → 事件环延迟 P95",
        "ms",
        series((step) => step.target.lagP95Ms),
        { xLabel: "在线玩家", logY: true }
      )
    : fullCharts;

  const body = `<h1>BakaGame 后端吞吐压测报告</h1>
<p class="lede">实时玩法面（Bun + Elysia，三个游戏 WS 房间）容量与带宽测量 · 生成于 ${new Date().toISOString().slice(0, 16).replace("T", " ")} UTC · ${reports.length} 次运行</p>
<section class="concl">
<h2>结论</h2>
${conclusion(reports)}
</section>
${capMatrix(reports)}
<section>
<h2>测量机</h2>
<p class="meta">${esc(String(host.platform ?? ""))} ${esc(String(host.release ?? ""))} · ${esc(String(host.cpuModel ?? ""))} · ${esc(String(host.logicalCpus ?? ""))} 线程 · ${fmt(Number(host.totalMemoryMb ?? 0) / 1024, 0)} GB 内存 · Bun ${esc(String(host.bun ?? ""))} · 最新一次运行源码 ${esc(latest.source?.commit ?? "未知")}${latest.source?.dirty ? "（含未提交改动）" : ""}</p>
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
  <li>Bun 玩法面是单线程事件循环：CPU 一核就是这个进程的天花板，跨核扩展要靠多进程分片，本报告不涉及。因此「核数没打满」不代表进程空闲，事件环 P95 与 ack P95 一起涨才是真瓶颈信号，本报告把它们当一等指标。</li>
  <li>节奏倍率 <code>pace</code>：房间内所有思考时间的除数。pace 1 接近真人房间，pace 4/24 是压缩节奏的压力模型；同一台机器的承载量在两种口径下不可直接混用。</li>
  <li>饱和判定按先到者：房间启动率 &lt; 80%、错误率 ≥ ${(latest.config.errorRateBudget * 100).toFixed(0)}%、ack P95 ≥ ${latest.config.latencyP95BudgetMs}ms、事件环 P95 ≥ ${latest.config.lagP95BudgetMs}ms、CPU 触顶（需要绑核，Windows 上不可用）、或玩家数继续增长而吞吐与带宽同时平掉。</li>
  <li>带宽为应用层统计（服务端发出与收到的 WS 帧字节）× 1.15 传输开销估算，未包含 TCP/TLS 握手与重传；真实公网带宽还要叠加 HTTP 静态资源与音频外链。</li>
  <li>压测生成器与被测进程同机运行，生成器自身 CPU 已在表内单列；本机是 ${esc(String(host.logicalCpus ?? "?"))} 线程开发机，绑核隔离（taskset）在 Windows 不可用，因此 CPU 为整进程口径，不是单核口径，且大玩家数下生成器本身就是共同上限。</li>
  <li>音频字节不进这条链路：猜歌只下发歌曲 ID 与音频地址，实际音频由客户端直连上游 CDN，所以本报告的带宽不含音频流量。</li>
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
