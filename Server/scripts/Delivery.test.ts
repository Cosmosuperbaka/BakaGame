import { expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { gunzipSync } from "node:zlib";
import { mkdtemp, rm, access } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { isolatedEnvironment, availablePort, startIsolatedServer } from "./IsolatedServer";
import {
  probeDeployment,
  HEALTH_QUOTA_REQUESTS,
  HEALTH_QUOTA_SHARE,
  HEALTH_WINDOW_MS,
  HEALTH_MIN_INTERVAL_MS,
} from "./DeploymentProbe";
// @ts-expect-error Node workflow helper intentionally remains native ESM JavaScript.
import { deploymentRevision } from "./DeploymentGate.mjs";
// @ts-expect-error Node helper intentionally remains native ESM JavaScript.
import { stage as stageNpmLock, DEFAULT_MAX_B64_CHARS } from "./StageNpmLock.mjs";

const repository = "Cosmosuperbaka/BakaGame";
const run = {
  path: ".github/workflows/ci.yml",
  name: "CI",
  event: "push",
  head_branch: "main",
  status: "completed",
  conclusion: "success",
  head_sha: "a".repeat(40),
  head_repository: { full_name: repository },
};
const jobs = [{ name: "Server CI", conclusion: "success" }];
test("门禁仅接受同仓 main push 的获验完整 SHA，手动选择不能绕过", () => {
  expect(deploymentRevision(run, jobs, repository)).toBe(run.head_sha);
  for (const patch of [
    { path: ".github/workflows/other.yml" },
    { conclusion: "failure" },
    { conclusion: "cancelled" },
    { event: "pull_request" },
    { status: "in_progress" },
    { head_branch: "other" },
    { head_repository: { full_name: "fork/BakaGame" } },
    { head_sha: "main" },
  ]) {
    expect(deploymentRevision({ ...run, ...patch }, jobs, repository)).toBeNull();
  }
  for (const conclusion of ["skipped", "failure", "cancelled"])
    expect(deploymentRevision(run, [{ name: "Server CI", conclusion }], repository)).toBeNull();
  expect(deploymentRevision(run, [], repository)).toBeNull();
});

test("main 推进后仍 fetch/reset 获验 SHA，数据下载经 manifest 校验", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "bakagame-git-fixture-"));
  const git = (...args: string[]) => {
    return execFileSync("git", args, {
      cwd: directory,
      encoding: "utf-8",
      timeout: 5_000,
      env: {
        ...isolatedEnvironment(process.env, 1, directory, "git-fixture"),
        GIT_CONFIG_NOSYSTEM: "1",
        GIT_CONFIG_GLOBAL: process.platform === "win32" ? "NUL" : "/dev/null",
      },
      stdio: ["ignore", "pipe", "pipe"],
    }).trim();
  };
  try {
    git("init", "-b", "main");
    git("config", "user.name", "fixture");
    git("config", "user.email", "fixture@example.invalid");
    git("-c", "commit.gpgsign=false", "commit", "--allow-empty", "-m", "A");
    const sha = git("rev-parse", "HEAD");
    const revision = deploymentRevision({ ...run, head_sha: sha }, jobs, repository);
    git("-c", "commit.gpgsign=false", "commit", "--allow-empty", "-m", "B");
    expect(git("rev-parse", "main")).not.toBe(sha);
    git("remote", "add", "origin", directory);
    git("fetch", "--no-tags", "origin", revision);
    git("reset", "--hard", revision);
    expect(git("rev-parse", "HEAD")).toBe(sha);
    const workflow = await Bun.file(
      path.resolve(import.meta.dir, "../../.github/workflows/deploy.yml")
    ).text();
    expect(workflow).toContain('REF="$DEPLOY_REV"');
    expect(workflow).toContain('git reset --hard "$DEPLOY_REV"');
    expect(workflow).not.toContain("origin/$REF");
    // 数据实体不再随代码分发：部署绝不搬走/替换服务器上的库（后端在持续更新它），
    // 只有「缺库 + 清单提供 dataset」时才按基线补发——下载地址取自 runner 从 manifest
    // 解析的变量，脚本只做格式校验、落盘按 sha256 兜底，数据引用同样不可被移动引用替换。
    expect(workflow).toContain('check_url "$BG_DATA_URL"');
    expect(workflow).toContain('"$(want_url "$b")"');
    expect(workflow).toContain("保留服务器现有数据库");
    expect(workflow).toContain("DATA_SYNC");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}, 20_000);

test("部署数据变量在写入侧与转发侧同名（GITHUB_ENV 大小写敏感）", async () => {
  const workflow = await Bun.file(
    path.resolve(import.meta.dir, "../../.github/workflows/deploy.yml")
  ).text();
  // 写入 $GITHUB_ENV 的名称必须与 appleboy envs 转发名完全一致：Linux 环境变量大小写敏感，
  // 曾经以 BG_CHAR_url 写入、以 BG_CHAR_URL 转发，真实部署在脚本首行校验即中止。
  const writes = workflow.match(/echo "\$\{var\}_[A-Za-z]+=/g) ?? [];
  expect(writes).toEqual(['echo "${var}_URL=', 'echo "${var}_SHA=', 'echo "${var}_SIZE=']);
  // resolve_one 的 var 实参、跳过分支写入的空值占位与转发名必须逐字同名（单库后为 BG_DATA_*）。
  expect(workflow).toContain("resolve_one dataset BG_DATA");
  expect(workflow).toContain(
    "envs: DEPLOY_REV,VERIFIED_RUN_ID,BG_DATA_URL,BG_DATA_SHA,BG_DATA_SIZE"
  );
  for (const name of ["BG_DATA_URL", "BG_DATA_SHA", "BG_DATA_SIZE"]) {
    expect(workflow).toContain(`echo "${name}=" >> "$GITHUB_ENV"`);
  }
});

test("环境白名单拒绝合成账号、遥测与代理，数据库落临时目录", () => {
  const env = isolatedEnvironment(
    {
      PATH: "fixture-path",
      SENTRY_DSN: "https://dummy.invalid",
      OTEL_EXPORTER_OTLP_ENDPOINT: "https://dummy.invalid",
      HTTPS_PROXY: "https://dummy.invalid",
      NETEASE_COOKIE: "dummy",
    },
    12345,
    tmpdir(),
    "owner"
  );
  expect(env.PATH).toBe("fixture-path");
  expect(env.SENTRY_DSN).toBe("");
  expect(env.OTEL_EXPORTER_OTLP_ENDPOINT).toBe("");
  expect(env.NETEASE_COOKIE).toBe("");
  expect(env.HTTPS_PROXY).toBeUndefined();
  expect(env.DATABASE_URL).toBe("");
});

// 与真实进程生命周期一致：15s 探活 + 最多 3s 停机，不能被 Bun 默认 5s 提前中断。
test("合成健康进程响应带自有标记，停止后临时目录已回收", async () => {
  const server = await startIsolatedServer(
    await availablePort(),
    path.join(import.meta.dir, "fixtures/OwnedServer.ts")
  );
  try {
    await server.ready();
    expect(await (await fetch(`${server.baseUrl}/__bakagame_test_owner`)).text()).toMatch(
      /^[0-9a-f-]{36}$/
    );
  } finally {
    await server.stop();
  }
  await expect(access(server.directory)).rejects.toThrow("ENOENT");
}, 20_000);

test("子进程退出时旧健康实例不能造成假绿", async () => {
  const port = await availablePort();
  const unrelated = Bun.serve({
    hostname: "127.0.0.1",
    port,
    fetch: () => Response.json({ status: "ok" }),
  });
  const server = await startIsolatedServer(
    port,
    path.join(import.meta.dir, "fixtures/ExitServer.ts")
  );
  try {
    await expect(server.ready()).rejects.toThrow(/自有服务|并非自有/);
  } finally {
    await server.stop();
    await unrelated.stop(true);
  }
});

test("只读发布探针拒绝 ready:false，不仅依赖 health ok", async () => {
  // 该断言验证 readiness 判定，不把 30ms 真实调度窗口当作分支到达保证。
  // 使用与生产同一探针与总预算逻辑；其他用例继续验证真实 HTTP/三协议 ACK。
  let now = 0;
  const paths: string[] = [];
  const fetcher = (async (input: string | URL | Request) => {
    const pathname = new URL(input instanceof Request ? input.url : String(input)).pathname;
    paths.push(pathname);
    return Response.json(
      pathname === "/readyz" ? { status: "ok", ready: false } : { status: "ok" }
    );
  }) as typeof fetch;
  await expect(
    probeDeployment("http://127.0.0.1:1", 30, undefined, {
      fetch: fetcher,
      now: () => now,
      sleep: async (ms) => {
        now += ms;
      },
    })
  ).rejects.toThrow("/readyz ready!=true");
  // /health 观察到一次 ok 后不再提问（/livez 与 /readyz 无额度，继续每轮问）。
  expect(paths).toEqual(["/health", "/livez", "/readyz", "/livez", "/readyz"]);
  expect(now).toBe(30);
});

/**
 * 夹具 WebSocket：收到命令立刻回一个 id 对应的 ack，让「订阅往返」这条分支
 * 在没有真实服务端的额度/退避用例里也能走通。
 */
const installAckWebSocket = () => {
  const original = globalThis.WebSocket;
  class AckSocket {
    private readonly listeners = new Map<string, Array<(event?: unknown) => void>>();
    constructor(readonly url: string) {
      setTimeout(() => this.dispatch("open"), 0);
    }
    addEventListener(type: string, handler: (event?: unknown) => void): void {
      const list = this.listeners.get(type) ?? [];
      list.push(handler);
      this.listeners.set(type, list);
    }
    removeEventListener(type: string, handler: (event?: unknown) => void): void {
      const list = this.listeners.get(type) ?? [];
      const at = list.indexOf(handler);
      if (at >= 0) list.splice(at, 1);
    }
    private dispatch(type: string, event?: unknown): void {
      for (const handler of [...(this.listeners.get(type) ?? [])]) handler(event);
    }
    send(raw: string): void {
      const packet = JSON.parse(raw) as { id: string; type: string };
      setTimeout(
        () =>
          this.dispatch("message", {
            data: JSON.stringify({
              id: packet.id,
              type: "ack",
              requestType: packet.type,
            }),
          }),
        0
      );
    }
    close(): void {}
  }
  globalThis.WebSocket = AckSocket as unknown as typeof WebSocket;
  return () => {
    globalThis.WebSocket = original;
  };
};

/** 假时钟：sleep 直接把 now 推前，用例因此可以在毫秒预算里走完整条退避链。 */
const fakeClock = () => {
  const clock = { now: 0 };
  return {
    clock,
    io: {
      now: () => clock.now,
      sleep: async (ms: number) => {
        clock.now += ms;
      },
    },
  };
};

const healthCalls = (paths: string[]): number => paths.filter((p) => p === "/health").length;

test("F82：/health 被限流 429 时探针继续等待而不是判失败，且提问次数受额度自我限速约束", async () => {
  const restore = installAckWebSocket();
  const paths: string[] = [];
  const fetcher = (async (input: string | URL | Request) => {
    const pathname = new URL(input instanceof Request ? input.url : String(input)).pathname;
    paths.push(pathname);
    if (pathname === "/health" && healthCalls(paths) <= 2) {
      // 与生产 429 同形：rateLimitHeaders() 会带 retry-after（秒）。
      return new Response(JSON.stringify({ status: "RATE_LIMITED" }), {
        status: 429,
        headers: { "retry-after": "1", "content-type": "application/json" },
      });
    }
    return Response.json({ status: "ok", ready: true });
  }) as typeof fetch;
  const { clock, io } = fakeClock();
  try {
    await probeDeployment("http://127.0.0.1:9", 30_000, undefined, { fetch: fetcher, ...io });
  } finally {
    restore();
  }
  // 30s 预算内旧实现会打出约 150 次 /health（超过单 IP 120 次/分的额度）；
  // 现在按额度自我限速，提问次数必须落在额度的一半以内。
  expect(healthCalls(paths)).toBeLessThanOrEqual(Math.floor(30_000 / HEALTH_MIN_INTERVAL_MS));
  expect(clock.now).toBeLessThan(30_000);
});

test("F82：/readyz 在停机窗口返回 503 时探针等待其转绿，不判失败", async () => {
  const restore = installAckWebSocket();
  const paths: string[] = [];
  const fetcher = (async (input: string | URL | Request) => {
    const pathname = new URL(input instanceof Request ? input.url : String(input)).pathname;
    paths.push(pathname);
    if (pathname === "/readyz" && paths.filter((p) => p === "/readyz").length <= 2)
      return Response.json({ status: "shutting_down", ready: false }, { status: 503 });
    return Response.json({ status: "ok", ready: true });
  }) as typeof fetch;
  const { io } = fakeClock();
  try {
    await probeDeployment("http://127.0.0.1:9", 30_000, undefined, { fetch: fetcher, ...io });
  } finally {
    restore();
  }
  expect(paths.filter((p) => p === "/readyz").length).toBeGreaterThanOrEqual(3);
});

test("F82：/health 请求超时同样只是「还没就绪」，恢复后探针通过", async () => {
  const restore = installAckWebSocket();
  const paths: string[] = [];
  const fetcher = (async (input: string | URL | Request) => {
    const pathname = new URL(input instanceof Request ? input.url : String(input)).pathname;
    paths.push(pathname);
    if (pathname === "/health" && healthCalls(paths) === 1)
      throw new Error("TimeoutError: The operation was aborted due to timeout");
    return Response.json({ status: "ok", ready: true });
  }) as typeof fetch;
  const { io } = fakeClock();
  try {
    await probeDeployment("http://127.0.0.1:9", 30_000, undefined, { fetch: fetcher, ...io });
  } finally {
    restore();
  }
  expect(healthCalls(paths)).toBe(2);
});

test("F82：额度始终打不开时报错带限流线索，供运维分辨「慢」与「坏」", async () => {
  const restore = installAckWebSocket();
  const fetcher = (async (input: string | URL | Request) => {
    const pathname = new URL(input instanceof Request ? input.url : String(input)).pathname;
    if (pathname === "/health")
      return new Response(JSON.stringify({ status: "RATE_LIMITED" }), {
        status: 429,
        headers: { "retry-after": "2", "content-type": "application/json" },
      });
    return Response.json({ status: "ok", ready: true });
  }) as typeof fetch;
  const { io } = fakeClock();
  try {
    await expect(
      probeDeployment("http://127.0.0.1:9", 5_000, undefined, { fetch: fetcher, ...io })
    ).rejects.toThrow(/限流 429[\s\S]*服务仍在启动/);
  } finally {
    restore();
  }
});

test("探针镜像的 /health 额度与 System.ts 的实现一致", async () => {
  // DeploymentProbe.ts 经 stdin 喂给容器，不能 import 应用代码，只能镜像额度。
  // 这条断言把镜像钉回真相源：改了 System.ts 的额度忘了这里，测试直接变红。
  const source = await Bun.file(
    path.resolve(import.meta.dir, "../src/transport/routes/System.ts")
  ).text();
  const window = /PROBE_WINDOW_MS\s*=\s*([\d_]+)/.exec(source)?.[1]?.replace(/_/g, "");
  const quota = /PROBE_IP_MAX_REQUESTS\s*=\s*([\d_]+)/.exec(source)?.[1]?.replace(/_/g, "");
  expect(window, "System.ts 里找不到 PROBE_WINDOW_MS，探针镜像常量需要人工核对").toBe(
    String(HEALTH_WINDOW_MS)
  );
  expect(quota, "System.ts 里找不到 PROBE_IP_MAX_REQUESTS，探针镜像常量需要人工核对").toBe(
    String(HEALTH_QUOTA_REQUESTS)
  );
  // 自我限速必须真的低于额度：一半的额度换算成间隔。
  expect(
    HEALTH_MIN_INTERVAL_MS * (HEALTH_QUOTA_REQUESTS / HEALTH_QUOTA_SHARE)
  ).toBeGreaterThanOrEqual(HEALTH_WINDOW_MS);
});

import { notifyDeployment } from "./DeploymentNotify";

test("Elysia 原生 routes/reload 保留测试所有者端点", async () => {
  const server = await startIsolatedServer(
    await availablePort(),
    path.join(import.meta.dir, "fixtures/ElysiaServer.ts")
  );
  try {
    await server.ready();
    expect(await (await fetch(`${server.baseUrl}/native-route`)).text()).toBe("ok");
  } finally {
    await server.stop();
  }
}, 20_000);

test("preload 拒绝全部登记出口，--no-env-file 不加载合成凭据", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "bakagame-env-fixture-"));
  try {
    await Bun.write(
      path.join(directory, ".env"),
      "FIXTURE_ENV_MARKER=dummy\nSENTRY_DSN=https://dummy.invalid\n"
    );
    const child = Bun.spawn(
      [
        process.execPath,
        "--no-env-file",
        "--preload",
        path.join(import.meta.dir, "fixtures/IsolatedPreload.ts"),
        path.join(import.meta.dir, "fixtures/DeniedEgress.ts"),
      ],
      {
        cwd: directory,
        env: isolatedEnvironment(process.env, 1, directory, "fixture"),
        stdout: "pipe",
        stderr: "pipe",
      }
    );
    const [stdout, stderr, exit] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ]);
    expect(stderr).toBe("");
    expect(exit).toBe(0);
    expect(JSON.parse(stdout)).toEqual({ checks: 16, marker: null, sentry: "" });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}, 20_000);

test("部署预算块的求和与作业硬超时自洽（审查 F59）", async () => {
  const workflow = Bun.YAML.parse(
    await Bun.file(path.resolve(import.meta.dir, "../../.github/workflows/deploy.yml")).text()
  ) as {
    jobs: {
      deploy: {
        "timeout-minutes"?: number;
        steps: { with?: { script?: unknown; command_timeout?: string } }[];
      };
    };
  };
  const script = workflow.jobs.deploy.steps
    .map((step) => step.with?.script)
    .find((value): value is string => typeof value === "string");
  if (typeof script !== "string") throw new Error("未找到内嵌部署脚本");
  const constant = (name: string): number => {
    const raw = new RegExp(`^\\s*${name}=(\\d+)(?:\\s|$)`, "m").exec(script)?.[1];
    if (raw === undefined) throw new Error(`预算块里找不到常量 ${name}`);
    return Number(raw);
  };
  const shardS =
    constant("BUDGET_NOTIFY_S") +
    constant("BUDGET_DRAIN_S") +
    constant("BUDGET_RESTART_S") +
    constant("BUDGET_PROBE_MAX_MS") / 1000;
  // 两片是「拆片回滚」时的上限（主片 + CEE 片）；当前生产已收敛为单片（实际最坏 226s），
  // 这里仍按两片算，保证脚本在重新拆片时不必回来改预算就能闭合。
  const worst =
    constant("BUDGET_SYNC_S") +
    constant("BUDGET_DL_MAX_S") +
    constant("BUDGET_CHECK_S") +
    constant("BUDGET_RELEASE_S") +
    shardS * 2 +
    constant("BUDGET_RESERVE_S");
  const jobS = constant("BUDGET_JOB_S");
  const timeoutMinutes = workflow.jobs.deploy["timeout-minutes"];
  expect(timeoutMinutes, "deploy job 必须保留硬超时").toBeNumber();
  expect(worst, `最坏路径 ${worst}s 必须落在远端预算 ${jobS}s 内`).toBeLessThanOrEqual(jobS);
  expect(jobS, "远端预算必须落在作业硬超时信封内").toBeLessThanOrEqual((timeoutMinutes ?? 0) * 60);
  // SSH 步骤的 command_timeout 必须与作业信封同一分钟数，否则两处会各自漂移。
  const commandTimeout = workflow.jobs.deploy.steps
    .map((step) => step.with?.command_timeout)
    .find((value): value is string => typeof value === "string");
  expect(commandTimeout, "SSH 步骤必须保留 command_timeout").toBe(`${timeoutMinutes}m`);
  // 下载余量由预算块推导，不再是与总时长脱钩的独立常数。
  expect(script).toContain("DL_DEADLINE=$(( BUDGET_JOB_S");
  expect(script).toContain("- SHARD_S * SHARDS ))");
  // 单片部署：清点列表只留主容器。CEE 片已下线，写回去会让脚本去滚动一个不存在的容器；
  // 若将来重新拆片，应当同时在服务器上重建容器，而不是只改这一行。
  expect(script).toContain("for c in BakaGame; do");
  expect(script, "CEE 片已下线，容器清点不得再列它").not.toContain(
    "for c in BakaGame BakaGame-cee; do"
  );
  // 每片探针预算取剩余时间，保证「等就绪」不会把整段脚本拖到被取消。
  expect(script).toContain("DEPLOY_PROBE_BUDGET_MS=$PROBE_MS");
});

test("npm 运行时锁只做搬运与校验，不重新解析（审查 F51）", async () => {
  const good = JSON.stringify({
    lockfileVersion: 3,
    packages: {
      "": { name: "bakagame-server-runtime", dependencies: { elysia: "1.4.30" } },
      "node_modules/elysia": { version: "1.4.30", resolved: "https://example.invalid/elysia.tgz" },
    },
  });
  const result = stageNpmLock(good, DEFAULT_MAX_B64_CHARS);
  expect(result.lockSha256).toMatch(/^[0-9a-f]{64}$/);
  expect(result.pins).toBe("elysia@1.4.30");
  expect(result.skipped).toBe("none");
  // 制品必须能原样还原：部署侧只认这一枚锁，不再产生第二套真相。
  expect(gunzipSync(Buffer.from(result.blob as string, "base64")).toString("utf8")).toBe(good);
  // 区间而非精确版本 = CI 侧 ExportNpmLock 的产物口径被破坏，必须失败而不是悄悄放过。
  expect(() =>
    stageNpmLock(
      JSON.stringify({
        lockfileVersion: 3,
        packages: {
          "": { dependencies: { elysia: "^1.4.30" } },
          "node_modules/elysia": { resolved: "x" },
        },
      })
    )
  ).toThrow(/精确版本/);
  expect(() =>
    stageNpmLock(
      JSON.stringify({ lockfileVersion: 2, packages: { "": { dependencies: { a: "1.0.0" } } } })
    )
  ).toThrow(/lockfileVersion/);
  expect(() =>
    stageNpmLock(
      JSON.stringify({
        lockfileVersion: 3,
        packages: { "": { dependencies: { a: "1.0.0" } }, "node_modules/a": { version: "1.0.0" } },
      })
    )
  ).toThrow(/resolved/);
  // 超限只跳过锁本体，pins 仍然可用（部署侧退化为版本核对 + 明确警告）。
  const tight = stageNpmLock(good, 32);
  expect(tight.blob).toBeNull();
  expect(tight.skipped).toBe("oversize");
  expect(tight.pins).toBe("elysia@1.4.30");

  // 部署作业必须真的消费制品：取 → 暂存 → 落到挂载树 → 容器内核对，缺一环都算回退。
  const workflow = Bun.YAML.parse(
    await Bun.file(path.resolve(import.meta.dir, "../../.github/workflows/deploy.yml")).text()
  ) as { jobs: { deploy: { steps: Array<Record<string, unknown>> } } };
  const text = JSON.stringify(workflow.jobs.deploy.steps);
  expect(text).toContain("server-npm-lock");
  expect(text).toContain("StageNpmLock.mjs");
  expect(text).toContain("NPM_LOCK_B64,NPM_LOCK_SHA,NPM_PINS");
  expect(text).toContain("npm ci");
});

test("维护通知只向合成回环发送 Bearer，缺 token/拒绝均失败且不回显凭据", async () => {
  const received: string[] = [];
  const fixture = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: (request) => {
      received.push(request.headers.get("Authorization") ?? "");
      expect(request.headers.get("X-Real-IP")).toBeNull();
      return request.headers.get("Authorization") === "Bearer fixture-secret"
        ? Response.json({ status: "ok" })
        : new Response(null, { status: 401 });
    },
  });
  try {
    const url = `http://127.0.0.1:${fixture.port}`;
    await expect(notifyDeployment(undefined, url)).rejects.toThrow("未配置 MAINTENANCE_TOKEN");
    expect(received).toHaveLength(0);
    await notifyDeployment("fixture-secret", url);
    await expect(notifyDeployment("wrong-fixture", url)).rejects.toThrow("维护通知被拒绝 (401)");
    expect(received).toEqual(["Bearer fixture-secret", "Bearer wrong-fixture"]);
  } finally {
    await fixture.stop(true);
  }
});

for (const valid of [true, false])
  test(`三协议部署 ACK ${valid ? "成功" : "拒绝"}夹具`, async () => {
    const fixture = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch(request, server) {
        if (request.headers.get("upgrade") === "websocket" && server.upgrade(request)) return;
        return Response.json({ status: "ok", ready: true });
      },
      websocket: {
        message(socket, message) {
          const request = JSON.parse(String(message));
          socket.send(
            JSON.stringify({
              type: valid ? "ack" : "error",
              id: request.id,
              requestType: request.type,
            })
          );
        },
      },
    });
    try {
      const probe = probeDeployment(`http://127.0.0.1:${fixture.port}`, 100);
      if (valid) await probe;
      else await expect(probe).rejects.toThrow("订阅 ACK 无效");
    } finally {
      await fixture.stop(true);
    }
  });

test("工作流 YAML 可解析且 E2E 数据取用与部署入口契约明确", async () => {
  const root = path.resolve(import.meta.dir, "../..");
  // 数据集不再由 CI 生产（每周发布流程已删除，tools/ 不进版本控制），工作流仅剩 ci 与 deploy。
  for (const name of ["ci", "deploy"]) {
    const parsed = Bun.YAML.parse(
      await Bun.file(path.join(root, `.github/workflows/${name}.yml`)).text()
    ) as { jobs: Record<string, unknown>; on: Record<string, unknown> };
    expect(Object.keys(parsed.jobs).length).toBeGreaterThan(0);
    expect(Object.keys(parsed.on).length).toBeGreaterThan(0);
    if (name === "ci") {
      const ci = JSON.stringify(parsed);
      // E2E 起真实服务端：从基线清单取数据集并按 sha256 校验；缺条目时给出可操作报错。
      expect(ci).toContain("fetch_one dataset bangumi.sqlite");
      expect(ci).toContain("sha256sum --check --strict");
      expect(ci).toContain("manifest 缺少 $id 条目");
      // 冒烟必须经工作区固定版 bun 调用：裸 `bun` 在 pnpm 化后的 PATH 上解析不到。
      expect(ci).toContain(
        "pnpm --filter server exec bun --no-env-file run scripts/ProductionSmoke.ts"
      );
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
  const child = Bun.spawn(
    [
      process.execPath,
      "--no-env-file",
      "--preload",
      path.join(import.meta.dir, "fixtures/IsolatedPreload.ts"),
      path.join(import.meta.dir, "fixtures/WorkerEgress.ts"),
    ],
    {
      cwd: import.meta.dir,
      env: isolatedEnvironment(process.env, 1, tmpdir(), "fixture"),
      stdout: "pipe",
      stderr: "pipe",
    }
  );
  const [stdout, stderr, exit] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  expect(stderr).toBe("");
  expect(exit).toBe(0);
  expect(stdout.trim()).toBe("隔离测试禁止主动网络出口");
}, 20_000);

test("部署内嵌 Bash 仅语法检查，不执行发布命令", async () => {
  const workflow = Bun.YAML.parse(
    await Bun.file(path.resolve(import.meta.dir, "../../.github/workflows/deploy.yml")).text()
  ) as { jobs: { deploy: { steps: { with?: { script?: unknown } }[] } } };
  // 带内嵌脚本的步骤已不再是 steps[0]（其前新增了 manifest 解析步），按内容定位，不依赖下标。
  const script = workflow.jobs.deploy.steps
    .map((step) => step.with?.script)
    .find((value): value is string => typeof value === "string");
  if (typeof script !== "string") throw new Error("deploy.yml 的 deploy job 中未找到内嵌部署脚本");
  execFileSync("bash", ["-n"], {
    input: script,
    encoding: "utf-8",
    timeout: 5_000,
    stdio: ["pipe", "pipe", "pipe"],
  });
  const inner = script.split("<<'BAKA_DEPLOY_EOF'\n")[1].split("\nBAKA_DEPLOY_EOF")[0];
  execFileSync("bash", ["-n"], {
    input: inner,
    encoding: "utf-8",
    timeout: 5_000,
    stdio: ["pipe", "pipe", "pipe"],
  });
  expect(inner).toContain('git reset --hard "$DEPLOY_REV"');
});

test("容器 stdin Bun 入口支持 TS 且 import.meta.main 触发", () => {
  const output = execFileSync(process.execPath, ["--no-env-file", "-"], {
    input: "const value: number = 7; if (import.meta.main) console.log(value);",
    encoding: "utf-8",
    timeout: 5_000,
    env: isolatedEnvironment(process.env, 1, tmpdir(), "stdin-fixture"),
    stdio: ["pipe", "pipe", "pipe"],
  });
  expect(output.trim()).toBe("7");
});

test("探活后子进程退出会中断后续验证，不会报告成功", async () => {
  const server = await startIsolatedServer(
    await availablePort(),
    path.join(import.meta.dir, "fixtures/ExitAfterReady.ts")
  );
  try {
    await server.ready();
    await expect(server.run(new Promise<never>(() => {}))).rejects.toThrow("自有服务退出 (24)");
  } finally {
    await Promise.all([server.stop(), server.stop()]);
  }
}, 20_000);
