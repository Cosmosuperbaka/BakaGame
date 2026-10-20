import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import assert from "node:assert/strict";

/**
 * 客户端发布门禁（ci.yml 的 client-publish）判定表单测。
 *
 * 背景（审查 F04）：这个作业 needs [desktop, android]，但两个壳的**触发条件不对称**——
 * desktop 的路径过滤只含 Desktop/**，android 还含 Client/**（安卓壳内嵌前端产物）。
 * 于是「只改前端」那次运行里 desktop 是 skipped、android 已经构建并签名了新 APK；
 * 若作业级门禁写成 `needs.desktop.result == 'success'`，症状是「每次都构建、永远不发布」，
 * 而且流水线全绿，没有任何地方报错。修法是把门禁拆成分平台判定，
 * 但 GitHub 的 `if:` 是自由文本，没人核对——本文件就是那张核对表。
 *
 * 做法：从 ci.yml 原文里抽出真实的表达式（不复制一份），把 `needs.*` / `github.*` / `env.*`
 * 换成夹具值后求值。GitHub 表达式去掉 `${{ }}` 后的 `== || &&` 子集就是合法 JS，
 * 因此这个求值近似但不假装精确：它守的是**我们自己写的判定关系**。
 */

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "../..");
const workflow = readFileSync(join(repoRoot, ".github/workflows/ci.yml"), "utf8").replaceAll(
  "\r\n",
  "\n"
);

/** 取某个作业（2 空格缩进的键）的正文行。 */
function jobLines(source, jobId) {
  const at = source.search(new RegExp(`\\n {2}${jobId}:\\n`));
  assert.notEqual(at, -1, `ci.yml 里找不到作业 ${jobId}`);
  const out = [];
  for (const line of source
    .slice(at + 1)
    .split("\n")
    .slice(1)) {
    if (line.trim() === "") continue;
    if (!/^ {4,}/.test(line)) break;
    out.push(line);
  }
  return out;
}

/** 读一条 `if:` 的值；折叠标量（`>-`）按空格续行拼接。 */
function readIf(lines, from, to, ifIndent) {
  for (let index = from; index < to; index += 1) {
    const match = lines[index].match(new RegExp(`^ {${ifIndent}}if:\\s*(.*)$`));
    if (!match) continue;
    const head = match[1].trim();
    const parts = /^[>|][-+0-9]*$/.test(head) ? [] : [head];
    for (let next = index + 1; next < to; next += 1) {
      const indent = lines[next].match(/^(\s*)/)[1].length;
      if (indent <= ifIndent) {
        if (parts.length === 0) assert.fail(`if 折叠标量没有内容：${lines[index]}`);
        return { text: parts.join(" ").trim(), at: index };
      }
      parts.push(lines[next].trim());
    }
    return { text: parts.join(" ").trim(), at: index };
  }
  return undefined;
}

/** 解析作业内每个步骤的 `{ name, if }`；步骤正文从 6 空格 `- name:` 起。 */
function stepsOf(lines) {
  const starts = lines
    .map((line, index) => ({ line, index }))
    .filter(({ line }) => /^ {6}- /.test(line));
  return starts.map(({ index }, order) => {
    const end = order + 1 < starts.length ? starts[order + 1].index : lines.length;
    const name = lines[index].match(/^ {6}- name:\s*(.+)$/)?.[1]?.trim();
    assert.ok(name, `步骤必须写成 "- name: ..."：${lines[index]}`);
    return { name, if: readIf(lines, index, end, 8) };
  });
}

const job = "client-publish";
const block = jobLines(workflow, job);
const jobIf = readIf(block, 0, block.length, 4);
assert.ok(jobIf, `作业 ${job} 没有作业级 if`);
const steps = stepsOf(block);
const step = (name) => {
  const found = steps.find((entry) => entry.name === name);
  assert.ok(found, `ci.yml 里没有名为 ${name} 的步骤（改名会让这张表失去意义）`);
  return found;
};

/** 把 GitHub 表达式里的上下文引用替换成夹具值，再当 JS 求值。 */
function evaluate(expression, context) {
  const body = expression.replace(/\$\{\{([^]*?)\}\}/g, "$1").replace(/\balways\(\)/g, "true");
  const keys = Object.keys(context).sort((a, b) => b.length - a.length);
  const code = body.replace(
    new RegExp(`(?<![\\w.'"])${keys.map((key) => key.replace(/[.]/g, "\\.")).join("|")}`, "g"),
    (match) => JSON.stringify(context[match])
  );
  // new Function 求值的对象是本仓库自己写的门禁表达式，不接受外部输入。
  return Boolean(new Function(`return (${code})`)());
}

const context = (event, ref, desktop, android, hasR2 = true) => ({
  "github.event_name": event,
  "github.ref": ref,
  "needs.desktop.result": desktop,
  "needs.android.result": android,
  "env.HAS_R2": hasR2 ? "true" : "false",
});

/** 判定表：[事件, 引用, desktop 结果, android 结果, 作业是否运行, 说明]。 */
const TABLE = [
  ["push", "refs/heads/main", "success", "success", true, "两个壳都成功"],
  // F04 的那次运行：纯前端改动 → desktop 被路径过滤跳过，android 已产出签名 APK。
  ["push", "refs/heads/main", "skipped", "success", true, "只改前端时 APK 必须仍能发布"],
  ["push", "refs/heads/main", "skipped", "skipped", false, "两壳都没构建就不进发布"],
  ["push", "refs/heads/main", "failure", "success", true, "桌面挂了不拖累安卓"],
  ["push", "refs/heads/main", "success", "failure", true, "安卓挂了不拖累桌面"],
  ["push", "refs/heads/main", "skipped", "failure", false, "只有失败面时不发布"],
  ["push", "refs/heads/main", "cancelled", "success", true, "依赖取消仍要能读到结果"],
  ["push", "refs/heads/topic", "success", "success", false, "非 main 分支不发布"],
  [
    "push",
    "refs/tags/v0.1.1",
    "success",
    "success",
    false,
    "标签触发不发布（版本号别名只跟 main）",
  ],
  [
    "workflow_dispatch",
    "refs/heads/main",
    "skipped",
    "success",
    true,
    "手动 dispatch 也要发布，否则永远补不了包",
  ],
  ["workflow_dispatch", "refs/heads/topic", "success", "success", false, "手动也只能从 main 发"],
  ["pull_request", "refs/pull/1/merge", "success", "success", false, "PR 绝不发布"],
];

test("作业级门禁：按平台分别放行，且带 always()", () => {
  assert.match(jobIf.text, /always\(\)/, "用 needs.*.result 判定必须写 always()");
  assert.match(jobIf.text, /needs\.desktop\.result/, "作业级门禁必须引用 desktop 结果");
  assert.match(jobIf.text, /needs\.android\.result/, "作业级门禁必须引用 android 结果");
  assert.doesNotMatch(
    jobIf.text,
    /needs\.desktop\.result == 'success' && needs\.android\.result == 'success'/,
    "写「两侧都得成功」会退回 F04：只改前端时安卓永不发布"
  );
});

for (const [event, ref, desktop, android, expected, why] of TABLE)
  test(`client-publish (${event} ${ref} desktop=${desktop} android=${android}) => ${expected}：${why}`, () =>
    assert.equal(evaluate(jobIf.text, context(event, ref, desktop, android)), expected));

const DESKTOP_STEPS = [
  "Download desktop installer",
  "Locate the installer",
  "Publish Windows installer",
];
const ANDROID_STEPS = ["Download release APK", "Publish Android APK"];

test("每个发布步骤只受自己那个平台的作业结果影响", () => {
  // 作业级放行后，步骤级必须再判自己那个平台；否则 desktop=skipped 时会去下载不存在的产物。
  for (const name of DESKTOP_STEPS)
    assert.match(
      step(name).if?.text ?? "",
      /needs\.desktop\.result == 'success'/,
      `${name} 必须以 desktop 作业成功为条件`
    );
  for (const name of ANDROID_STEPS)
    assert.match(
      step(name).if?.text ?? "",
      /needs\.android\.result == 'success'/,
      `${name} 必须以 android 作业成功为条件`
    );
  // 交叉条件一律不许出现：安卓步骤若判 desktop，就又把 F04 装回去了。
  for (const name of ANDROID_STEPS)
    assert.doesNotMatch(step(name).if?.text ?? "", /needs\.desktop/, `${name} 不该依赖桌面结果`);
  for (const name of DESKTOP_STEPS)
    assert.doesNotMatch(step(name).if?.text ?? "", /needs\.android/, `${name} 不该依赖安卓结果`);
});

test("步骤级条件在「只改前端」那次运行里的逐格结果", () => {
  const onlyFrontend = context("push", "refs/heads/main", "skipped", "success");
  for (const name of DESKTOP_STEPS)
    assert.equal(evaluate(step(name).if.text, onlyFrontend), false, name);
  for (const name of ANDROID_STEPS)
    assert.equal(evaluate(step(name).if.text, onlyFrontend), true, name);
});

test("缺对象存储凭证时所有上传步骤都不跑，但审计步骤照常跑", () => {
  const noR2 = context("push", "refs/heads/main", "success", "success", false);
  for (const name of [...DESKTOP_STEPS, ...ANDROID_STEPS])
    assert.equal(evaluate(step(name).if.text, noR2), false, name);
  // 审计步骤没有任何条件：它必须每次都说清「这次在发哪一侧」，包括凭证缺失的场合。
  const audit = step("Report which platforms this run publishes");
  assert.equal(audit.if, undefined);
  assert.ok(
    steps.indexOf(audit) < steps.indexOf(step("Publish Windows installer")),
    "审计输出要排在发布步骤之前"
  );
  for (const name of [...DESKTOP_STEPS, ...ANDROID_STEPS])
    assert.equal(
      evaluate(step(name).if.text, context("push", "refs/heads/main", "success", "success")),
      true,
      name
    );
});
