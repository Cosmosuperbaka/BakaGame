import { gzipSync } from "node:zlib";
import { spawnSync } from "node:child_process";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import {
  BUDGETS,
  analyze,
  evaluate,
  type FirstScreenMetrics,
} from "../../scripts/first-screen-budget.mjs";

// transform 后 import.meta.url 不是 file: 协议，退回测试进程目录（约定为 Client 根）。
const scriptPath = (() => {
  try {
    return fileURLToPath(new URL("../../scripts/first-screen-budget.mjs", import.meta.url));
  } catch {
    return join(process.cwd(), "scripts/first-screen-budget.mjs");
  }
})();

// 门禁吃的是 dist 形状，这里造一份最小可算的产物：只有一条真样式表会挡首屏，
// print 那条必须被排除，否则「按 media 拆分」会变成把非阻塞资源也算进预算。

const face = (i: number) => `@font-face{font-family:f${i};src:url(f${i}.woff2)}`;
const build = ({
  faces = 1,
  logoBytes = 1024,
  faviconBytes = 1024,
  extraFontBytes = 2048,
} = {}) => {
  // 每条 @font-face 用不同族名：重复文本会被 gzip 压扁，那样条数与字节两条上限测不开。
  const css = `${Array.from({ length: faces }, (_, i) => face(i)).join("\n")}\nbody{color:red}`;
  const files = new Map<string, Buffer>([
    ["index.css", Buffer.from(css)],
    ["print.css", Buffer.from("@page{margin:0}".repeat(4))],
    ["entry.js", Buffer.from("console.log(1)".repeat(64))],
    ["pre.js", Buffer.from("console.log(2)".repeat(256))],
    ["x.woff2", Buffer.alloc(extraFontBytes, 7)],
    ["logo.webp", Buffer.alloc(logoBytes, 1)],
    ["favicon.webp", Buffer.alloc(faviconBytes, 1)],
  ]);
  const htmlText = [
    '<link rel="stylesheet" href="/assets/index.css">',
    '<link rel="stylesheet" media="print" href="/assets/print.css">',
    '<script type="module" src="/assets/entry.js"></script>',
    '<link rel="modulepreload" href="/assets/pre.js">',
  ].join("\n");
  return { htmlText, files, css };
};

describe("first-screen-budget", () => {
  it("measures only render-blocking sheets and the entry JS graph", () => {
    const { metrics } = analyze({ ...build(), budgets: BUDGETS });
    // 等于「只有 index.css 的 gz」就说明 print 那条被排除了。
    expect(metrics.entryCssGzBytes).toBe(gzipSync(Buffer.from(build().css)).length);
    expect(metrics.entryJsGraphGzBytes).toBe(
      gzipSync(Buffer.from("console.log(1)".repeat(64))).length +
        gzipSync(Buffer.from("console.log(2)".repeat(256))).length
    );
    expect(metrics.largestChunkName).toBe("pre.js");
    expect(metrics.entryFontFaceRules).toBe(1);
    expect(metrics.emittedFontFiles).toBe(1);
    // 出档资源与字体字节按原始字节计（浏览器下载的是已压缩体，这里量的是落盘大小）：
    // 钉住具体数字，口径被改成「个数」或「gzip 后」都会红。
    expect(metrics.emittedFontBytes).toBe(2048);
    expect(metrics.logoBytes).toBe(1024);
    expect(metrics.faviconBytes).toBe(1024);
  });

  it("passes a synthetic dist kept inside every budget", () => {
    const { violations, metrics } = analyze(build());
    expect(violations).toEqual([]);
    for (const key of Object.keys(BUDGETS) as (keyof typeof BUDGETS)[]) {
      expect(metrics[key]).toBeLessThanOrEqual(BUDGETS[key]);
    }
  });

  it("reports every single budget that is exceeded", () => {
    // 逐条钉住：任何一条预算被写错、被静默撤掉或度量口径漂移，这一例都会红。
    const base = analyze(build()).metrics;
    for (const key of Object.keys(BUDGETS) as (keyof typeof BUDGETS)[]) {
      const over: FirstScreenMetrics = { ...base, [key]: BUDGETS[key] + 1 };
      expect(evaluate(over, BUDGETS)).toEqual([
        { key, value: BUDGETS[key] + 1, limit: BUDGETS[key] },
      ]);
    }
  });

  it("refuses to silently drop a budget when the metrics shape drifts", () => {
    const base = analyze(build()).metrics;
    const drifted = { ...base } as Partial<FirstScreenMetrics>;
    delete drifted.emittedFontBytes;
    expect(() => evaluate(drifted as FirstScreenMetrics, BUDGETS)).toThrow(/emittedFontBytes/);
  });

  it("点名每一项越界的预算，不误报未越界的", () => {
    const { metrics, violations } = analyze(build({ faces: 400, logoBytes: 900_000 }));
    expect(violations.map((v) => v.key).sort()).toEqual(["entryFontFaceRules", "logoBytes"]);
    // 400 条结构重复的 @font-face 只让「条数」越界，字节仍在上限内：
    // 条数与字节是两条独立口径，这条就是它们没被写混的证据。
    expect(metrics.entryCssGzBytes).toBeLessThan(BUDGETS.entryCssGzBytes);
    expect(metrics.faviconBytes).toBeLessThanOrEqual(BUDGETS.faviconBytes);
  });

  it("命令行只在越界时退出码 1，并把那一项点名到 stderr", async () => {
    // 门禁的牙齿在退出码上：不跑到 CLI 这一层，`verify` 里那条命令随时可能退化成只打印。
    const runOn = async (logoBytes: number) => {
      const dir = await mkdtemp(join(tmpdir(), "first-screen-budget-"));
      const assetDir = join(dir, "assets");
      await mkdir(assetDir, { recursive: true });
      const { htmlText, files } = build({ logoBytes });
      await writeFile(join(dir, "index.html"), htmlText);
      for (const [name, bytes] of files) await writeFile(join(assetDir, name), bytes);
      const run = spawnSync(process.execPath, [scriptPath, "--dist", dir], { encoding: "utf8" });
      await rm(dir, { recursive: true, force: true });
      return { status: run.status, stdout: run.stdout, stderr: run.stderr };
    };
    const passed = await runOn(1024);
    expect(passed.status).toBe(0);
    expect(passed.stdout).toContain("包体门禁通过");
    const failed = await runOn(900_000);
    expect(failed.status).toBe(1);
    expect(failed.stderr).toContain("logoBytes");
    expect(failed.stderr).not.toContain("entryCssGzBytes:");
  }, 30_000); // 两次冷启动 node 子进程：机器满载时默认 5s 会把这条判红，与门禁逻辑无关。
});
