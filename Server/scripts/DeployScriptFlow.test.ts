import { afterAll, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

/**
 * 把部署工作流里内嵌的那段脚本放进沙箱真正执行一遍：docker、git、sudo 等换成记账的假命令，
 * 仓库目录换成临时目录。语法检查只能证明脚本能被解析；「容器已退出」「依赖不符」「重启后起不来」
 * 这些分支在真实发布里一年碰不到几次，不执行就没有任何东西守着它们。
 */

const NEW_REV = "a".repeat(40);
const OLD_REV = "b".repeat(40);
const sandboxes: string[] = [];
afterAll(() => {
  for (const dir of sandboxes) rmSync(dir, { recursive: true, force: true });
});

const innerDeployScript = async (): Promise<string> => {
  const workflow = Bun.YAML.parse(
    await Bun.file(path.resolve(import.meta.dir, "../../.github/workflows/deploy.yml")).text()
  ) as { jobs: { deploy: { steps: { with?: { script?: unknown } }[] } } };
  const script = workflow.jobs.deploy.steps
    .map((step) => step.with?.script)
    .find((value): value is string => typeof value === "string");
  if (typeof script !== "string") throw new Error("未找到内嵌部署脚本");
  return script
    .replaceAll("\r", "")
    .split("<<'BAKA_DEPLOY_EOF'\n")[1]
    .split("\nBAKA_DEPLOY_EOF")[0];
};

interface Scenario {
  /** 发布开始时容器是否在运行。 */
  running: boolean;
  /** 挂载树当前所在的修订。 */
  head: string;
  /** 探针依次返回的结果；用完之后一律算通过。 */
  probes: ("ok" | "fail")[];
  /** 依赖核对的结果。 */
  pins: "ok" | "bad";
}

/** 假命令：只记账、按场景文件应答，不碰真实的容器与仓库。 */
const STUBS: Record<string, string> = {
  sudo: `#!/usr/bin/env bash\nexec "$@"\n`,
  timeout: `#!/usr/bin/env bash\nshift\nexec "$@"\n`,
  sleep: `#!/usr/bin/env bash\nexit 0\n`,
  git: `#!/usr/bin/env bash
echo "git $*" >> "$FLOW_STATE/calls"
case "$1" in
  rev-parse) cat "$FLOW_STATE/head" ;;
  reset) echo "$3" > "$FLOW_STATE/head" ;;
  *) : ;;
esac
`,
  docker: `#!/usr/bin/env bash
case "$1" in
  ps) echo BakaGame ;;
  inspect) cat "$FLOW_STATE/running" ;;
  start) echo "docker start" >> "$FLOW_STATE/calls"; echo true > "$FLOW_STATE/running" ;;
  restart) echo "docker restart" >> "$FLOW_STATE/calls"; echo true > "$FLOW_STATE/running" ;;
  logs) printf '%s\\n' '12:00:00 INFO 聊天 玩家小明说了一句话' '12:00:01 ERROR 启停 进程起不来了' ;;
  exec)
    kind=$(head -n 1)
    echo "docker exec $kind" >> "$FLOW_STATE/calls"
    case "$kind" in
      *release*)
        commit=""
        while [ "$#" -gt 0 ]; do
          if [ "$1" = "-" ]; then commit="$2"; break; fi
          shift
        done
        printf '{"revision":"%s"}\\n' "$commit"
        ;;
      *notify*) exit 0 ;;
      *pins*) [ "$(cat "$FLOW_STATE/pins")" = ok ] ;;
      *probe*)
        next=$(head -n 1 "$FLOW_STATE/probes" 2>/dev/null || true)
        if [ -n "$next" ]; then
          tail -n +2 "$FLOW_STATE/probes" > "$FLOW_STATE/probes.rest"
          mv -f "$FLOW_STATE/probes.rest" "$FLOW_STATE/probes"
        fi
        [ "$next" != fail ]
        ;;
      *) echo "假 docker 不认识的容器内脚本：$kind" >&2; exit 97 ;;
    esac
    ;;
  *) echo "假 docker 不认识的子命令：$1" >&2; exit 98 ;;
esac
`,
};

const runDeploy = async (scenario: Scenario, pins = "elysia@1.4.30") => {
  const root = mkdtempSync(path.join(tmpdir(), "deploy-flow-")).replaceAll("\\", "/");
  sandboxes.push(root);
  const repo = `${root}/repo`;
  const state = `${root}/state`;
  const bin = `${root}/bin`;
  for (const dir of [
    `${repo}/Server/data`,
    `${repo}/Server/build`,
    `${repo}/Server/src/infrastructure`,
    `${repo}/Server/scripts`,
    `${repo}/Client/src/data`,
    state,
    bin,
  ])
    mkdirSync(dir, { recursive: true });
  writeFileSync(`${repo}/Server/data/bangumi.sqlite`, `SQLite format 3\0${"x".repeat(64)}`);
  writeFileSync(`${repo}/Server/build/release.json`, `{"revision":"${scenario.head}"}\n`);
  writeFileSync(`${repo}/Client/src/data/changelog.json`, `{"entries":[]}\n`);
  writeFileSync(`${repo}/Server/src/infrastructure/Release.ts`, "// release\n");
  writeFileSync(`${repo}/Server/scripts/DeploymentNotify.ts`, "// notify\n");
  writeFileSync(`${repo}/Server/scripts/DeploymentProbe.ts`, "// probe\n");
  writeFileSync(`${repo}/Server/scripts/NpmPinVerify.ts`, "// pins\n");
  writeFileSync(`${state}/head`, `${scenario.head}\n`);
  writeFileSync(`${state}/running`, `${String(scenario.running)}\n`);
  writeFileSync(`${state}/probes`, scenario.probes.map((result) => `${result}\n`).join(""));
  writeFileSync(`${state}/pins`, `${scenario.pins}\n`);
  writeFileSync(`${state}/calls`, "");
  for (const [name, body] of Object.entries(STUBS)) {
    writeFileSync(`${bin}/${name}`, body);
    chmodSync(`${bin}/${name}`, 0o755);
  }
  const script = (await innerDeployScript()).replaceAll("/BakaGame", repo);
  writeFileSync(`${root}/deploy.sh`, script);
  // 假命令目录排在搜索路径最前面。键名在各平台大小写不同，就地找出来再改写。
  const inherited: Record<string, string | undefined> = { ...process.env };
  const pathKey = Object.keys(inherited).find((key) => key.toUpperCase() === "PATH") ?? "PATH";
  const run = spawnSync("bash", [`${root}/deploy.sh`], {
    encoding: "utf8",
    timeout: 60_000,
    env: {
      ...inherited,
      [pathKey]: `${bin}${path.delimiter}${inherited[pathKey] ?? ""}`,
      FLOW_STATE: state,
      DEPLOY_REV: NEW_REV,
      VERIFIED_RUN_ID: "1",
      NPM_PINS: pins,
      BG_DATA_URL: "",
      BG_DATA_SHA: "",
      BG_DATA_SIZE: "",
      NPM_LOCK_B64: "",
      NPM_LOCK_SHA: "",
    },
  });
  const read = (file: string) => readFileSync(file, "utf8").trim();
  return {
    code: run.status,
    output: `${run.stdout}${run.stderr}`,
    calls: read(`${state}/calls`).split("\n").filter(Boolean),
    head: read(`${state}/head`),
    release: read(`${repo}/Server/build/release.json`),
  };
};

const count = (calls: string[], call: string) => calls.filter((line) => line === call).length;

describe("部署脚本在沙箱里真正执行", () => {
  test("正常发布：先核对依赖，再预告、重启、验收，最后再核对一次", async () => {
    const run = await runDeploy({ running: true, head: OLD_REV, probes: ["ok"], pins: "ok" });
    expect(run.output).toContain("部署成功");
    expect(run.code).toBe(0);
    expect(run.head).toBe(NEW_REV);
    expect(run.release).toBe(`{"revision":"${NEW_REV}"}`);
    const order = run.calls.filter((line) => line.startsWith("docker"));
    expect(order).toEqual([
      "docker exec // release",
      "docker exec // pins",
      "docker exec // notify",
      "docker restart",
      "docker exec // probe",
      "docker exec // pins",
    ]);
  }, 120_000);

  test("依赖与获验锁不符：重启之前就中止，线上进程不动，代码树放回上一修订", async () => {
    const run = await runDeploy({ running: true, head: OLD_REV, probes: [], pins: "bad" });
    expect(run.code).toBe(1);
    expect(run.output).toContain("线上进程未重启");
    expect(count(run.calls, "docker restart")).toBe(0);
    expect(count(run.calls, "docker start")).toBe(0);
    expect(count(run.calls, "docker exec // notify")).toBe(0);
    expect(run.head).toBe(OLD_REV);
    expect(run.release).toBe(`{"revision":"${OLD_REV}"}`);
  }, 120_000);

  test("重启后起不来：自动回到上一修订再拉起，验收通过后仍报本轮失败", async () => {
    const run = await runDeploy({
      running: true,
      head: OLD_REV,
      probes: ["fail", "ok"],
      pins: "ok",
    });
    expect(run.code).toBe(1);
    expect(run.output).toContain("已自动回到上一修订并恢复服务");
    expect(count(run.calls, "docker restart")).toBe(2);
    expect(count(run.calls, "docker exec // probe")).toBe(2);
    expect(run.head).toBe(OLD_REV);
    expect(run.release).toBe(`{"revision":"${OLD_REV}"}`);
  }, 120_000);

  test("回到上一修订后仍起不来：只回这一次，之后交运维", async () => {
    const run = await runDeploy({
      running: true,
      head: OLD_REV,
      probes: ["fail", "fail"],
      pins: "ok",
    });
    expect(run.code).toBe(1);
    expect(run.output).toContain("回到上一修订后仍未就绪");
    expect(count(run.calls, "docker restart")).toBe(2);
    // 工作流日志是公开的：失败时只带出错误与启停行，对局内容不外带。
    expect(run.output).toContain("进程起不来了");
    expect(run.output).not.toContain("玩家小明");
    expect(run.head).toBe(OLD_REV);
  }, 120_000);

  test("容器已退出：按本轮修订直接拉起，不预告不重启，验收后核对依赖", async () => {
    const run = await runDeploy({ running: false, head: OLD_REV, probes: ["ok"], pins: "ok" });
    expect(run.output).toContain("部署成功");
    expect(run.code).toBe(0);
    expect(run.head).toBe(NEW_REV);
    expect(count(run.calls, "docker start")).toBe(1);
    expect(count(run.calls, "docker restart")).toBe(0);
    expect(count(run.calls, "docker exec // notify")).toBe(0);
    // 容器没在运行时无从在重启之前核对，只在验收之后核对一次。
    expect(count(run.calls, "docker exec // pins")).toBe(1);
  }, 120_000);

  test("同一修订重发后起不来：没有可回的修订，不做自动动作", async () => {
    const run = await runDeploy({ running: true, head: NEW_REV, probes: ["fail"], pins: "ok" });
    expect(run.code).toBe(1);
    expect(run.output).toContain("没有可回的上一修订");
    expect(count(run.calls, "docker restart")).toBe(1);
    expect(run.head).toBe(NEW_REV);
  }, 120_000);
});
