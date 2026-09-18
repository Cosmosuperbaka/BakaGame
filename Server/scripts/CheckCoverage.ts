import { resolve } from "node:path";

type CoverageTotals = {
  functionsFound: number;
  functionsHit: number;
  linesFound: number;
  linesHit: number;
};

const thresholds = {
  functions: 92.87,
  lines: 95.45,
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
