import { resolve } from "node:path";

type CoverageTotals = {
  functionsFound: number;
  functionsHit: number;
  linesFound: number;
  linesHit: number;
};

// 覆盖率棘轮阈值。**与 bun 的插桩口径强绑定，换 bun 版本必须同步重校**。
//
// 实测对照（同一份代码、同一批 501 条测试，仅换 bun 可执行文件）：
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
// 实测 13374/14181 = 94.3092…% 会被 toFixed(2) 显示为 94.31，若阈值也填 94.31
// 则出现 `lines=94.31% < 94.31%` 的自反失败（已踩过）。
const thresholds = {
  functions: 90.6,
  lines: 94.2,
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
      const separator = line.indexOf(":");
      if (separator < 0) continue;

      const key = line.slice(0, separator);
      const found = Number(line.slice(separator + 1));
      if (!Number.isFinite(found)) continue;

      if (key === "FNF") totals.functionsFound += found;
      if (key === "FNH") totals.functionsHit += found;
      if (key === "LF") totals.linesFound += found;
      if (key === "LH") totals.linesHit += found;
    }
  }

  return totals;
};

const percentage = (hit: number, found: number): number =>
  found === 0 ? 100 : (hit / found) * 100;

if (import.meta.main) {
const coveragePath = resolve(import.meta.dir, "../coverage/lcov.info");
const lcov = Bun.file(coveragePath);
if (!(await lcov.exists())) {
  throw new Error(`未找到覆盖率报告: ${coveragePath}`);
}

const totals = parseLcov(await lcov.text());
if (!totals.functionsFound || !totals.linesFound) throw new Error('覆盖率报告缺少有效的函数或行计数');
const actual = {
  functions: percentage(totals.functionsHit, totals.functionsFound),
  lines: percentage(totals.linesHit, totals.linesFound),
};

console.log(
  `服务端覆盖率: 函数 ${actual.functions.toFixed(2)}% (门槛 ${thresholds.functions.toFixed(2)}%), 行 ${actual.lines.toFixed(2)}% (门槛 ${thresholds.lines.toFixed(2)}%)`,
);

const failures = Object.entries(thresholds).filter(([metric, threshold]) => actual[metric as keyof typeof actual] < threshold);
if (failures.length > 0) {
  throw new Error(`覆盖率低于门槛: ${failures.map(([metric, threshold]) => `${metric}=${actual[metric as keyof typeof actual].toFixed(2)}% < ${threshold.toFixed(2)}%`).join(", ")}`);
}
}
