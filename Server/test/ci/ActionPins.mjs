import test from "node:test";
import assert from "node:assert/strict";
import { readdirSync } from "node:fs";
import { join } from "node:path";
import { parse } from "yaml";
import { readRepoFile, repoRoot } from "./support/Workflow.mjs";

/**
 * 工作流里的第三方 Action 必须钉到完整提交哈希：tag 可以在不改工作流的前提下换实现，
 * 部署作业里的 Action 又持有主机凭据，被换掉就等于交出主机。
 * 本文件只守「写法」（40 位哈希 + 版本注释），哈希是否真对应该版本要靠升级时 `git ls-remote` 实查。
 */

const workflowsDir = join(repoRoot, ".github/workflows");
const files = readdirSync(workflowsDir).filter((name) => /\.ya?ml$/.test(name));

/** 收集所有 uses 引用，连同它在源文本里的行，便于检查版本注释。 */
function usesOf(file) {
  const text = readRepoFile(".github/workflows", file);
  const doc = parse(text);
  const found = [];
  for (const [jobId, job] of Object.entries(doc.jobs ?? {})) {
    if (typeof job.uses === "string") found.push({ jobId, uses: job.uses });
    for (const step of job.steps ?? [])
      if (typeof step.uses === "string") found.push({ jobId, uses: step.uses });
  }
  const lines = text.split("\n");
  return found.map((entry) => ({
    ...entry,
    line: lines.find((line) => line.includes(`uses: ${entry.uses}`)) ?? "",
  }));
}

test("至少解析到工作流文件与 uses 引用（防解析空转）", () => {
  assert.ok(files.length >= 2);
  assert.ok(files.flatMap(usesOf).length > 10);
});

for (const file of files)
  test(`${file}：所有 Action 都钉到 40 位提交哈希并带版本注释`, () => {
    for (const { uses, line } of usesOf(file)) {
      if (uses.startsWith("./")) continue;
      assert.match(uses, /^[\w.-]+\/[\w./-]+@[0-9a-f]{40}$/, `${uses} 没有钉到完整提交哈希`);
      assert.match(line, /#\s*\S+/, `${uses} 缺少版本注释`);
    }
  });

test("钉哈希的判定本身能识别 tag 写法（防正则放水）", () => {
  const pattern = /^[\w.-]+\/[\w./-]+@[0-9a-f]{40}$/;
  assert.equal(pattern.test("actions/checkout@v4"), false);
  assert.equal(pattern.test(`actions/checkout@${"a".repeat(40)}`), true);
});
