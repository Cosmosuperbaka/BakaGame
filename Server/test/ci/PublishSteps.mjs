import test from "node:test";
import assert from "node:assert/strict";
import { readRepoFile, stepsOf } from "./support/Workflow.mjs";

/**
 * 客户端发布步骤的两条性质（ci.yml 的 client-publish 与 macos-publish）：
 *
 * 1. 按版本幂等：同一版本只发一次。只改 ci.yml 或只改前端的提交也会重跑壳作业，重打出来的是
 *    同版本号的另一份构建；覆盖长缓存的版本化对象会让 CDN 里的包与签名对不上。macOS 在计划作业里
 *    判重，Windows 与安卓在上传步骤开头判重，判重必须排在任何上传之前。
 * 2. 发布完预热 CDN：别名、签名与版本旁文件各请求一次，服务端的首次探测才不会撞冷缓存。
 *    预热失败只能打警告，绝不能让发布失败；地址取服务端配置里的下载地址默认值，常量改名会让
 *    预热静默失效，所以这里也核对名字。
 *
 * 只核对脚本原文里的结构关系，脚本本身的行为靠发布时的日志与人工演练（假 aws / curl）确认。
 */

const runOf = (job, name) => {
  const found = stepsOf(job).find((entry) => entry.name === name);
  assert.ok(typeof found?.run === "string", `${job} 里没有带脚本的步骤 ${name}`);
  return found.run;
};
const stepOf = (job, name) => {
  const found = stepsOf(job).find((entry) => entry.name === name);
  assert.ok(found, `${job} 里没有步骤 ${name}（改名会让这张表失去意义）`);
  return found;
};

/** [作业, 步骤, 判重用的版本化对象] */
const ONCE_PER_VERSION = [
  ["client-publish", "Publish Windows installer", "BakaGame-$version-x64.exe"],
  ["client-publish", "Publish Android APK", "BakaGame-$version-release.apk"],
];

/** [作业, 步骤, 预热地址所在的环境变量] */
const WARMED = [
  ["client-publish", "Publish Windows installer", ["PUBLIC_URL"]],
  ["client-publish", "Publish Android APK", ["PUBLIC_URL"]],
  ["macos-publish", "Publish macOS installer and updater package", ["DMG_URL", "UPDATER_URL"]],
];

test("Windows 与安卓按版本幂等：先查版本化对象，在桶里就整步跳过", () => {
  for (const [job, name, key] of ONCE_PER_VERSION) {
    const run = runOf(job, name);
    const check = run.indexOf(`if exists "${key}"; then`);
    assert.ok(check >= 0, `${name} 没有按版本化对象 ${key} 判重`);
    const firstUpload = run.indexOf(" s3 cp ");
    assert.ok(firstUpload > check, `${name} 的判重必须排在第一次上传之前`);
    assert.match(
      run.slice(check),
      /^if exists "[^"]+"; then\n\s*echo "::notice::[^\n]*"\n\s*exit 0\n\s*fi\n/,
      `${name} 判重命中后要整步退出（不传包、不动别名与旁文件）`
    );
    assert.ok(
      run.includes(`"s3://$R2_BUCKET/${key}"`),
      `${name} 判重的对象与上传的版本化对象不是同一个`
    );
    assert.match(run, /s3api head-object/);
  }
});

test("macOS 的判重仍在计划作业里，按 dmg 判", () => {
  const run = runOf("macos-release-plan", "Decide whether this version needs publishing");
  assert.match(run, /if exists "BakaGame-\$version-universal\.dmg"; then/);
});

test("三端发布完都预热 CDN：排在写版本旁文件之后，失败只警告", () => {
  for (const [job, name, vars] of WARMED) {
    const run = runOf(job, name);
    // curl 失败由 || 接住，只打警告；地址为空时跳过而不是报错
    assert.match(
      run,
      /curl -fsS[^\n]*\\\n\s*\|\| echo "::warning::/,
      `${name} 的预热失败必须只警告`
    );
    assert.match(run, /\[ -n "\$base" \] \|\| \{ echo "::warning::[^"]*"; return 0; \}/);
    const sidecars = [...run.matchAll(/BakaGame-latest-[^"\s]*\.version"/g)];
    assert.ok(sidecars.length > 0, `${name} 没有写版本旁文件`);
    const firstWarm = run.search(/^\s*warm "\$/m);
    assert.ok(firstWarm > 0, `${name} 没有调用预热`);
    assert.ok(
      firstWarm > sidecars[0].index,
      `${name} 的预热要排在写版本旁文件之后：先预热会把旧版本缓存进 CDN`
    );
    const env = stepOf(job, name).env ?? {};
    for (const variable of vars) {
      assert.match(
        String(env[variable]),
        /steps\.cdn\.outputs\./,
        `${name} 的 ${variable} 要取读地址那一步的输出`
      );
      assert.match(run, new RegExp(`warm "\\$${variable}"`), `${name} 没有预热 ${variable}`);
    }
  }
});

test("预热地址取自服务端的下载地址默认值，常量名对得上", () => {
  const defaults = readRepoFile("Server/src/config/env/ClientChannel.ts");
  for (const job of ["client-publish", "macos-publish"]) {
    const checkout = stepOf(job, "Checkout public download addresses");
    assert.equal(checkout.with?.["sparse-checkout"], "Server/src/config/env/ClientChannel.ts");
    assert.equal(checkout["continue-on-error"], true, "检出失败不能拖垮发布");
    const run = runOf(job, "Read public download addresses");
    const names = [...run.matchAll(/url_of (DEFAULT_[A-Z_]+_URL)/g)].map((match) => match[1]);
    assert.ok(names.length >= 2, `${job} 读地址那一步没有点名任何常量`);
    for (const name of names)
      assert.match(
        defaults,
        new RegExp(`const ${name} =\\s*"https://[^"]+"`),
        `服务端配置里没有 ${name}：改名会让预热静默失效`
      );
  }
});
