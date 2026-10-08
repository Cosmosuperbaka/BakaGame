import { expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdtemp, rm, access } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { isolatedEnvironment, availablePort, startIsolatedServer } from "./IsolatedServer";
import { probeDeployment } from "./DeploymentProbe";
// @ts-expect-error Node workflow helper intentionally remains native ESM JavaScript.
import { deploymentRevision } from "./DeploymentGate.mjs";

const repository = "Cosmosuperbaka/BakaGame";
const run = { path: ".github/workflows/ci.yml", name: "CI", event: "push", head_branch: "main", status: "completed", conclusion: "success", head_sha: "a".repeat(40), head_repository: { full_name: repository } };
const jobs = [{ name: "Server CI", conclusion: "success" }];
test("门禁仅接受同仓 main push 的获验完整 SHA，手动选择不能绕过", () => {
  expect(deploymentRevision(run, jobs, repository)).toBe(run.head_sha);
  for (const patch of [{ path: ".github/workflows/other.yml" }, { conclusion: "failure" }, { conclusion: "cancelled" }, { event: "pull_request" }, { status: "in_progress" }, { head_branch: "other" }, { head_repository: { full_name: "fork/BakaGame" } }, { head_sha: "main" }]) {
    expect(deploymentRevision({ ...run, ...patch }, jobs, repository)).toBeNull();
  }
  for (const conclusion of ["skipped", "failure", "cancelled"]) expect(deploymentRevision(run, [{ name: "Server CI", conclusion }], repository)).toBeNull();
  expect(deploymentRevision(run, [], repository)).toBeNull();
});

test("main 推进后仍 fetch/reset 获验 SHA，数据下载经 manifest 校验", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "bakagame-git-fixture-"));
  const git = (...args: string[]) => {
    return execFileSync("git", args, {
      cwd: directory, encoding: "utf-8", timeout: 5_000,
      env: { ...isolatedEnvironment(process.env, 1, directory, "git-fixture"), GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: process.platform === "win32" ? "NUL" : "/dev/null" },
      stdio: ["ignore", "pipe", "pipe"],
    }).trim();
  };
  try {
    git("init", "-b", "main"); git("config", "user.name", "fixture"); git("config", "user.email", "fixture@example.invalid");
    git("-c", "commit.gpgsign=false", "commit", "--allow-empty", "-m", "A");
    const sha = git("rev-parse", "HEAD");
    const revision = deploymentRevision({ ...run, head_sha: sha }, jobs, repository);
    git("-c", "commit.gpgsign=false", "commit", "--allow-empty", "-m", "B");
    expect(git("rev-parse", "main")).not.toBe(sha);
    git("remote", "add", "origin", directory);
    git("fetch", "--no-tags", "origin", revision);
    git("reset", "--hard", revision);
    expect(git("rev-parse", "HEAD")).toBe(sha);
    const workflow = await Bun.file(path.resolve(import.meta.dir, "../../.github/workflows/deploy.yml")).text();
    expect(workflow).toContain('REF="$DEPLOY_REV"');
    expect(workflow).toContain('git reset --hard "$DEPLOY_REV"');
    expect(workflow).not.toContain('origin/$REF');
    // 数据分发自 R2 迁移后不再有 raw URL 拼接：下载地址取自 runner 从 manifest 解析的变量，
    // 脚本只做格式校验，落盘按 sha256 兜底（数据与代码修订解耦，但同样不可被移动引用替换）。
    expect(workflow).toContain('check_url "$BG_CHAR_URL"');
    expect(workflow).toContain('"$(want_url "$b")"');
  } finally { await rm(directory, { recursive: true, force: true }); }
}, 20_000);

test("环境白名单拒绝合成账号、遥测与代理，数据库落临时目录", () => {
  const env = isolatedEnvironment({ PATH: "fixture-path", SENTRY_DSN: "https://dummy.invalid", OTEL_EXPORTER_OTLP_ENDPOINT: "https://dummy.invalid", HTTPS_PROXY: "https://dummy.invalid", NETEASE_COOKIE: "dummy" }, 12345, tmpdir(), "owner");
  expect(env.PATH).toBe("fixture-path"); expect(env.SENTRY_DSN).toBe(""); expect(env.OTEL_EXPORTER_OTLP_ENDPOINT).toBe("");
  expect(env.NETEASE_COOKIE).toBe(""); expect(env.HTTPS_PROXY).toBeUndefined(); expect(env.WORD_BANK_PATH).toBe(path.join(tmpdir(), "words.sqlite"));
});

// 与真实进程生命周期一致：15s 探活 + 最多 3s 停机，不能被 Bun 默认 5s 提前中断。
test("合成健康进程响应带自有标记，停止后临时目录已回收", async () => {
  const server = await startIsolatedServer(await availablePort(), path.join(import.meta.dir, "fixtures/OwnedServer.ts"));
  try { await server.ready(); expect(await (await fetch(`${server.baseUrl}/__bakagame_test_owner`)).text()).toMatch(/^[0-9a-f-]{36}$/); }
  finally { await server.stop(); }
  await expect(access(server.directory)).rejects.toThrow("ENOENT");
}, 20_000);

test("子进程退出时旧健康实例不能造成假绿", async () => {
  const port = await availablePort();
  const unrelated = Bun.serve({ hostname: "127.0.0.1", port, fetch: () => Response.json({ status: "ok" }) });
  const server = await startIsolatedServer(port, path.join(import.meta.dir, "fixtures/ExitServer.ts"));
  try { await expect(server.ready()).rejects.toThrow(/自有服务|并非自有/); }
  finally { await server.stop(); unrelated.stop(true); }
});

test("只读发布探针拒绝 ready:false，不仅依赖 health ok", async () => {
  // 该断言验证 readiness 判定，不把 30ms 真实调度窗口当作分支到达保证。
  // 使用与生产同一探针与总预算逻辑；其他用例继续验证真实 HTTP/三协议 ACK。
  let now = 0;
  const paths: string[] = [];
  const fetcher = (async (input: string | URL | Request) => {
    const pathname = new URL(input instanceof Request ? input.url : String(input)).pathname;
    paths.push(pathname);
    return Response.json(pathname === "/readyz" ? { status: "ok", ready: false } : { status: "ok" });
  }) as typeof fetch;
  await expect(probeDeployment("http://127.0.0.1:1", 30, undefined, {
    fetch: fetcher, now: () => now, sleep: async ms => { now += ms; },
  })).rejects.toThrow("业务探针失败: /readyz");
  expect(paths).toEqual(["/health", "/livez", "/readyz", "/health", "/livez", "/readyz"]);
  expect(now).toBe(30);
});

import { notifyDeployment } from "./DeploymentNotify";

test("Elysia 原生 routes/reload 保留测试所有者端点", async () => {
  const server = await startIsolatedServer(await availablePort(), path.join(import.meta.dir, "fixtures/ElysiaServer.ts"));
  try { await server.ready(); expect(await (await fetch(`${server.baseUrl}/native-route`)).text()).toBe("ok"); }
  finally { await server.stop(); }
}, 20_000);

test("preload 拒绝全部登记出口，--no-env-file 不加载合成凭据", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "bakagame-env-fixture-"));
  try {
    await Bun.write(path.join(directory, ".env"), "FIXTURE_ENV_MARKER=dummy\nSENTRY_DSN=https://dummy.invalid\n");
    const child = Bun.spawn([process.execPath, "--no-env-file", "--preload", path.join(import.meta.dir, "fixtures/IsolatedPreload.ts"), path.join(import.meta.dir, "fixtures/DeniedEgress.ts")], {
      cwd: directory, env: isolatedEnvironment(process.env, 1, directory, "fixture"), stdout: "pipe", stderr: "pipe",
    });
    const [stdout, stderr, exit] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
    expect(stderr).toBe(""); expect(exit).toBe(0);
    expect(JSON.parse(stdout)).toEqual({ checks: 16, marker: null, sentry: "" });
  } finally { await rm(directory, { recursive: true, force: true }); }
}, 20_000);

test("维护通知只向合成回环发送 Bearer，缺 token/拒绝均失败且不回显凭据", async () => {
  const received: string[] = [];
  const fixture = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: request => {
    received.push(request.headers.get("Authorization") ?? "");
    expect(request.headers.get("X-Real-IP")).toBeNull();
    return request.headers.get("Authorization") === "Bearer fixture-secret" ? Response.json({ status: "ok" }) : new Response(null, { status: 401 });
  } });
  try {
    const url = `http://127.0.0.1:${fixture.port}`;
    await expect(notifyDeployment(undefined, url)).rejects.toThrow("未配置 MAINTENANCE_TOKEN");
    expect(received).toHaveLength(0);
    await notifyDeployment("fixture-secret", url);
    await expect(notifyDeployment("wrong-fixture", url)).rejects.toThrow("维护通知被拒绝 (401)");
    expect(received).toEqual(["Bearer fixture-secret", "Bearer wrong-fixture"]);
  } finally { fixture.stop(true); }
});

for (const valid of [true, false]) test(`三协议部署 ACK ${valid ? "成功" : "拒绝"}夹具`, async () => {
  const fixture = Bun.serve({ hostname: "127.0.0.1", port: 0,
    fetch(request, server) {
      if (request.headers.get("upgrade") === "websocket" && server.upgrade(request)) return;
      return Response.json({ status: "ok", ready: true });
    },
    websocket: { message(socket, message) {
      const request = JSON.parse(String(message));
      socket.send(JSON.stringify({ type: valid ? "ack" : "error", id: request.id, requestType: request.type }));
    } },
  });
  try {
    const probe = probeDeployment(`http://127.0.0.1:${fixture.port}`, 100);
    if (valid) await probe;
    else await expect(probe).rejects.toThrow("订阅 ACK 无效");
  } finally { fixture.stop(true); }
});

test("工作流 YAML 可解析且手动发布与 Python PR 入口契约明确", async () => {
  const root = path.resolve(import.meta.dir, "../..");
  for (const name of ["ci", "deploy", "bangumi-data"]) {
    const parsed = Bun.YAML.parse(await Bun.file(path.join(root, `.github/workflows/${name}.yml`)).text()) as { jobs: Record<string, unknown>; on: Record<string, unknown> };
    expect(Object.keys(parsed.jobs).length).toBeGreaterThan(0);
    expect(Object.keys(parsed.on).length).toBeGreaterThan(0);
    if (name === "ci") {
      expect(parsed.jobs).toHaveProperty("tools");
      const ci = JSON.stringify(parsed);
      expect(ci).toContain("python3 -B tools/test_build_bangumi_db.py");
      expect(ci).toContain("bun --no-env-file run scripts/ProductionSmoke.ts");
    }
    if (name === "deploy") {
      expect(parsed.on).toHaveProperty("workflow_dispatch.inputs.ci_run_id.required", true);
      const deploy = JSON.stringify(parsed);
      expect(deploy).not.toContain("X-Real-IP");
      expect(deploy).toContain("DeploymentNotify.ts");
      expect(deploy).toContain("DeploymentProbe.ts");
      expect(deploy).toContain("filter: 'latest'");
    }
  }
});

test("Worker 继承出口守卫，不能跨线程访问第三方", async () => {
  const child = Bun.spawn([process.execPath, "--no-env-file", "--preload", path.join(import.meta.dir, "fixtures/IsolatedPreload.ts"), path.join(import.meta.dir, "fixtures/WorkerEgress.ts")], {
    cwd: import.meta.dir, env: isolatedEnvironment(process.env, 1, tmpdir(), "fixture"), stdout: "pipe", stderr: "pipe",
  });
  const [stdout, stderr, exit] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
  expect(stderr).toBe(""); expect(exit).toBe(0); expect(stdout.trim()).toBe("隔离测试禁止主动网络出口");
}, 20_000);


test("部署内嵌 Bash 仅语法检查，不执行发布命令", async () => {
  const workflow = Bun.YAML.parse(await Bun.file(path.resolve(import.meta.dir, "../../.github/workflows/deploy.yml")).text()) as { jobs: { deploy: { steps: { with?: { script?: unknown } }[] } } };
  // 带内嵌脚本的步骤已不再是 steps[0]（其前新增了 manifest 解析步），按内容定位，不依赖下标。
  const script = workflow.jobs.deploy.steps.map((step) => step.with?.script).find((value): value is string => typeof value === "string");
  if (typeof script !== "string") throw new Error("deploy.yml 的 deploy job 中未找到内嵌部署脚本");
  execFileSync("bash", ["-n"], { input: script, encoding: "utf-8", timeout: 5_000, stdio: ["pipe", "pipe", "pipe"] });
  const inner = script.split("<<'BAKA_DEPLOY_EOF'\n")[1].split("\nBAKA_DEPLOY_EOF")[0];
  execFileSync("bash", ["-n"], { input: inner, encoding: "utf-8", timeout: 5_000, stdio: ["pipe", "pipe", "pipe"] });
  expect(inner).toContain('git reset --hard "$DEPLOY_REV"');
});


test("容器 stdin Bun 入口支持 TS 且 import.meta.main 触发", () => {
  const output = execFileSync(process.execPath, ["--no-env-file", "-"], {
    input: 'const value: number = 7; if (import.meta.main) console.log(value);', encoding: "utf-8", timeout: 5_000,
    env: isolatedEnvironment(process.env, 1, tmpdir(), "stdin-fixture"), stdio: ["pipe", "pipe", "pipe"],
  });
  expect(output.trim()).toBe("7");
});

test("探活后子进程退出会中断后续验证，不会报告成功", async () => {
  const server = await startIsolatedServer(await availablePort(), path.join(import.meta.dir, "fixtures/ExitAfterReady.ts"));
  try {
    await server.ready();
    await expect(server.run(new Promise<never>(() => {}))).rejects.toThrow("自有服务退出 (24)");
  } finally { await Promise.all([server.stop(), server.stop()]); }
}, 20_000);
