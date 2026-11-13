import { expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { parseLcov } from "../scripts/CheckCoverage";

test("覆盖率门禁累加单值计数而非误读行命中记录", () => {
  const report =
    "SF:one.ts\nFNF:10\nFNH:8\nDA:1,6\nLF:100\nLH:90\nend_of_record\nSF:two.ts\nFNF:5\nFNH:4\nLF:20\nLH:10\nend_of_record";
  expect(parseLcov(report)).toEqual({
    functionsFound: 15,
    functionsHit: 12,
    linesFound: 120,
    linesHit: 100,
  });
  expect(parseLcov("SF:missing.ts\nFNF:nan\nLF:none\nend_of_record")).toEqual({
    functionsFound: 0,
    functionsHit: 0,
    linesFound: 0,
    linesHit: 0,
  });
});

const runGate = (lcov: string) => {
  const dir = mkdtempSync(path.join(tmpdir(), "coverage-gate-"));
  try {
    const report = path.join(dir, "lcov.info");
    writeFileSync(report, lcov);
    const result = Bun.spawnSync(
      [process.execPath, "run", path.resolve(import.meta.dir, "../scripts/CheckCoverage.ts"), report],
      { stdout: "pipe", stderr: "pipe" }
    );
    return {
      exitCode: result.exitCode,
      output: `${result.stdout.toString()}${result.stderr.toString()}`,
    };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
};

test("测试全绿但覆盖率低于门槛时，门禁脚本以非零退出", () => {
  const result = runGate("SF:a.ts\nFNF:100\nFNH:10\nLF:100\nLH:10\nend_of_record\n");
  expect(result.exitCode).not.toBe(0);
  expect(result.output).toContain("覆盖率低于门槛");
});

test("覆盖率达标时门禁脚本以零退出", () => {
  const result = runGate("SF:a.ts\nFNF:100\nFNH:100\nLF:100\nLH:100\nend_of_record\n");
  expect(result.exitCode).toBe(0);
});

test("覆盖率报告缺失时门禁脚本以非零退出，而不是当作通过", () => {
  const result = Bun.spawnSync(
    [process.execPath, "run", path.resolve(import.meta.dir, "../scripts/CheckCoverage.ts"), path.join(tmpdir(), "no-such-lcov.info")],
    { stdout: "pipe", stderr: "pipe" }
  );
  expect(result.exitCode).not.toBe(0);
});
