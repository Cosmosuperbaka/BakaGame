import { resolve } from "node:path";

type CoverageTotals = {
  functionsFound: number;
  functionsHit: number;
  linesFound: number;
  linesHit: number;
};

type CoverageMetric = keyof typeof thresholds;

// 覆盖率棘轮阈值。**与 bun 的插桩口径强绑定，换 bun 版本必须同步重校**。
//
// 实测对照（同一份代码、同一批测试，仅换 bun 可执行文件）：
//   bun 1.3.x  → functions 93.65% (3361/3589)、lines 97.00% (27380/28227)
//   bun 1.4.2  → functions 90.66% (1495/1649)、lines 94.31% (13374/14181)
// 两版的分母相差 2 倍以上（函数 3589 vs 1649），因此数值下降是**口径变化**，
// 不是覆盖质量回退。历史阈值 92.87 / 95.45 即照 1.3.x 口径标定。
//
// 注意 `bun run test:coverage` 会触发 `node_modules/.bin` 前置，脚本内层 `bun`
// 实际解析到 `Server/package.json` 里 pin 的 bun 版本（而非全局 bun），
// 所以那次 pin 变更会直接改变测量仪器。改动 bun pin 时务必重跑本门禁。
//
// 阈值取值规则：实测值向下留约 0.1pp 余量再取整，**不要直接填实测的 toFixed(2) 值** ——
// 显示值与阈值同值会出现 `lines=94.31% < 94.31%` 的自反失败。
//
// 新增无库可跑的仓储会拉低实测行覆盖，这是阈值需要重校的信号：补覆盖的正路是给仓储做可注入的
// 连接桩，而不是继续往下调阈值。
//
// 2026-10-26 按 1.4.2 口径重校：补上 9 个 Drizzle 仓储的连接桩用例（`test/DrizzleStub.ts`）、
// 三款游戏的 MCP 界面层用例与 MCP 客户端的真实 WebSocket 用例后，实测
// functions 92.38% (4447/4814)、lines 94.09% (39549/42033)，据此定下面的阈值。
// 仍未覆盖的主要两处，都不适合按「无库可跑」的正路补：
// `application/CreateServer.ts` 的生产装配体（要起数据 Worker 与真实上游，启动前的
// 生产配置校验由 `test/Env.test.ts` 覆盖）、`scripts/SongRandomnessProbe.ts` 的联网
// 主流程（显式运行的真实歌单探针，纯函数部分已由 `test/SongRandomnessProbe.test.ts` 覆盖）。
const thresholds = {
  functions: 92.2,
  lines: 93.9,
};

// LCIF 单值总计记录（FNF / FNH / LF / LH）到累加字段的映射。
// 其余 `KEY:count` 形式的逐行记录（如 DA）不在此表内，因此不会被误当成总数累加。
const TOTAL_KEYS: Record<string, keyof CoverageTotals> = {
  FNF: "functionsFound",
  FNH: "functionsHit",
  LF: "linesFound",
  LH: "linesHit",
};

const accumulateTotalRecord = (totals: CoverageTotals, line: string): void => {
  const separator = line.indexOf(":");
  if (separator < 0) return;

  const field = TOTAL_KEYS[line.slice(0, separator)];
  if (!field) return;

  const found = Number(line.slice(separator + 1));
  if (!Number.isFinite(found)) return;

  totals[field] += found;
};

export const parseLcov = (text: string): CoverageTotals => {
  const totals: CoverageTotals = {
    functionsFound: 0,
    functionsHit: 0,
    linesFound: 0,
    linesHit: 0,
  };

  for (const record of text.split("end_of_record")) {
    for (const line of record.split(/\r?\n/)) {
      accumulateTotalRecord(totals, line);
    }
  }

  return totals;
};

const percentage = (hit: number, found: number): number =>
  found === 0 ? 100 : (hit / found) * 100;

const toActualCoverage = (totals: CoverageTotals): Record<CoverageMetric, number> => ({
  functions: percentage(totals.functionsHit, totals.functionsFound),
  lines: percentage(totals.linesHit, totals.linesFound),
});

const describeGateFailure = (
  actual: Record<CoverageMetric, number>,
  failures: CoverageMetric[]
): string =>
  `覆盖率低于门槛: ${failures
    .map((metric) => `${metric}=${actual[metric].toFixed(2)}% < ${thresholds[metric].toFixed(2)}%`)
    .join(", ")}`;

if (import.meta.main) {
  const coveragePath = resolve(import.meta.dir, "../coverage/lcov.info");
  const lcov = Bun.file(coveragePath);
  if (!(await lcov.exists())) {
    throw new Error(`未找到覆盖率报告: ${coveragePath}`);
  }

  const totals = parseLcov(await lcov.text());
  if (!totals.functionsFound || !totals.linesFound)
    throw new Error("覆盖率报告缺少有效的函数或行计数");
  const actual = toActualCoverage(totals);

  console.log(
    `服务端覆盖率: 函数 ${actual.functions.toFixed(2)}% (门槛 ${thresholds.functions.toFixed(2)}%), 行 ${actual.lines.toFixed(2)}% (门槛 ${thresholds.lines.toFixed(2)}%)`
  );

  const failures = (Object.keys(thresholds) as CoverageMetric[]).filter(
    (metric) => actual[metric] < thresholds[metric]
  );
  if (failures.length > 0) {
    throw new Error(describeGateFailure(actual, failures));
  }
}
