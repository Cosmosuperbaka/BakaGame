import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import assert from "node:assert/strict";
import { parse } from "yaml";

/**
 * CI 门禁测试共用的工作流读取与解析。
 *
 * 三份门禁（路径过滤、发布判定表、构建工具链）都要读 ci.yml：以前各自按缩进切行，
 * 缩进、折叠标量或锚点写法一变就红得莫名其妙。这里统一用 YAML 解析器取结构，
 * 门禁只面对解析后的对象，不再依赖排版。
 */

const here = dirname(fileURLToPath(import.meta.url));

/** 仓库根：本文件位于 Server/test/ci/support。 */
export const repoRoot = resolve(here, "../../../..");

/** 工作区可能是 CRLF（core.autocrlf），统一成 LF 再交给解析与正则。 */
export const readRepoFile = (...segments) =>
  readFileSync(join(repoRoot, ...segments), "utf8").replaceAll("\r\n", "\n");

export const workflowText = readRepoFile(".github/workflows/ci.yml");
export const workflow = parse(workflowText);

export function job(id) {
  const found = workflow.jobs?.[id];
  assert.ok(found, `ci.yml 里找不到作业 ${id}`);
  return found;
}

/** 作业的步骤列表，每步至少有 name（缺 name 的步骤无法被门禁点名，直接报红）。 */
export function stepsOf(id) {
  const steps = job(id).steps ?? [];
  for (const step of steps) assert.ok(step.name, `作业 ${id} 里有未命名的步骤：${JSON.stringify(step)}`);
  return steps;
}

/** 折叠标量解析后末尾带换行，比较与求值前统一去掉首尾空白。 */
export const conditionOf = (node) => (typeof node?.if === "string" ? node.if.trim() : undefined);

/** changes 作业对外导出的过滤名。 */
export const declaredOutputs = () => Object.keys(job("changes").outputs ?? {});

/**
 * `dorny/paths-filter` 的 `filters` 输入本身是一段 YAML 文本，再解析一次得到
 * `{ 过滤名: [模式...] }`。解析失败或形状不符都直接报红，避免静默空转。
 */
export function changeFilters() {
  const step = stepsOf("changes").find((entry) => entry.id === "filter");
  assert.ok(step, "changes 作业里找不到 id 为 filter 的步骤");
  const raw = step.with?.filters;
  assert.equal(typeof raw, "string", "filter 步骤缺少 filters 输入");
  const parsed = parse(raw);
  assert.ok(parsed && typeof parsed === "object", "filters 输入不是映射");
  for (const [name, patterns] of Object.entries(parsed))
    assert.ok(
      Array.isArray(patterns) && patterns.every((pattern) => typeof pattern === "string"),
      `过滤集合 ${name} 必须是字符串列表`
    );
  return parsed;
}
