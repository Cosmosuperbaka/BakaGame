import { afterEach, expect, spyOn, test } from "bun:test";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { buildServerReleaseMetadata, latestStableVersion, parseServerReleaseMetadata, resolveServerRelease } from "../src/infrastructure/Release";

const SHA = "abcdef1".padEnd(40, "0");
const changelog = { entries: [{ version: "1.9.2" }, { version: "2.0.0-rc.1" }, { version: "1.10.0" }, { version: "1.9.10" }] };
const sourcePath = resolve(import.meta.dir, "../src/infrastructure/Release.ts");
const source = readFileSync(sourcePath, "utf8");
const directories: string[] = [];
afterEach(() => { for (const path of directories.splice(0)) rmSync(path, { recursive: true, force: true }); });
const fixture = () => {
  const root = mkdtempSync(join(tmpdir(), "bakagame-release-")); directories.push(root);
  const serverRoot = join(root, "Server"); mkdirSync(join(serverRoot, "build"), { recursive: true });
  return { root, serverRoot, metadataPath: join(serverRoot, "build/release.json") };
};
const putMetadata = (f: ReturnType<typeof fixture>, metadata: unknown) => writeFileSync(f.metadataPath, JSON.stringify(metadata));
const childEnv = () => ({ ...process.env, SENTRY_DSN: "", OTEL_EXPORTER_OTLP_ENDPOINT: "", NODE_ENV: "test", MSYS2_ARG_CONV_EXCL: "*" });
const runGenerator = (f: ReturnType<typeof fixture>, args: string[]) => {
  // 与部署一致由 shell 从文件重定向到 helper stdin；不让 Windows 父进程持有 stdin 管道。
  writeFileSync(join(f.root, "MetadataHelper.ts"), source);
  const bash = Bun.which("bash");
  if (!bash) throw new Error("Release shell fixture requires bash (Git Bash on Windows)");
  return Bun.spawnSync([bash, "--noprofile", "--norc", "-c", 'timeout 3s "$FIXTURE_BUN" --no-env-file - "$@" < MetadataHelper.ts', "fixture", ...args], {
    cwd: f.root, stdin: "ignore", stdout: "pipe", stderr: "pipe",
    env: { ...childEnv(), FIXTURE_BUN: process.execPath.replaceAll("\\", "/") }, timeout: 4_000,
  });
};

test("最新稳定 semver 按数值选择，忽略预发布/前导零/畸形条目，不硬编码旧版本", () => {
  expect(latestStableVersion(changelog)).toBe("1.10.0");
  expect(latestStableVersion({ entries: [null, {}, { version: "01.20.0" }, { version: "V2.0.0" }, { version: "2.0.0+build" }, { version: 123 }, { version: "1.3.3" }] })).toBe("1.3.3");
  expect(latestStableVersion({ entries: [{ version: "9007199254740993.0.0" }, { version: "9007199254740992.9.9" }] })).toBe("9007199254740993.0.0");
  for (const value of [null, [], {}, { entries: [] }, { entries: [{ version: "1.3.2-beta" }] }]) expect(latestStableVersion(value)).toBeUndefined();
});

test("元数据只含 schemaVersion、完整 SHA 和稳定版本，拒绝无效输入及多余字段", () => {
  const metadata = buildServerReleaseMetadata(SHA, changelog);
  expect(metadata).toEqual({ schemaVersion: 1, revision: SHA, version: "1.10.0" });
  expect(parseServerReleaseMetadata(metadata)).toEqual(metadata);
  for (const revision of [undefined, "", "abcdef1", SHA.toUpperCase(), "g".repeat(40), "a".repeat(64), `${SHA}\n`]) expect(() => buildServerReleaseMetadata(revision, changelog)).toThrow();
  expect(() => buildServerReleaseMetadata(SHA, { entries: [] })).toThrow(/稳定 semver/);
  for (const value of [null, [], {}, { ...metadata, schemaVersion: 2 }, { ...metadata, revision: "abcdef1" }, { ...metadata, version: "1.3.2-rc1" }, { ...metadata, token: "dummy-secret" }]) expect(parseServerReleaseMetadata(value)).toBeUndefined();
});

test("无 Git、无 Client 的容器仅使用有效 metadata；缺失损坏均 undefined，不采信环境 release", () => {
  const f = fixture();
  const saved = { release: Bun.env.SENTRY_RELEASE, sha: Bun.env.GITHUB_SHA };
  try {
    Bun.env.SENTRY_RELEASE = "V99.99.99（1234567）"; Bun.env.GITHUB_SHA = "1".repeat(40);
    expect(resolveServerRelease(f.serverRoot)).toBeUndefined();
    putMetadata(f, buildServerReleaseMetadata(SHA, changelog));
    expect(existsSync(join(f.root, ".git"))).toBe(false); expect(existsSync(join(f.root, "Client"))).toBe(false);
    expect(resolveServerRelease(f.serverRoot)).toBe("V1.10.0（abcdef1）");
    for (const value of [{ revision: SHA, version: "1.10.0" }, { schemaVersion: 1, revision: "abcdef1", version: "1.10.0" }]) {
      putMetadata(f, value); expect(resolveServerRelease(f.serverRoot)).toBeUndefined();
    }
    writeFileSync(f.metadataPath, "truncated{"); expect(resolveServerRelease(f.serverRoot)).toBeUndefined();
  } finally {
    if (saved.release === undefined) delete Bun.env.SENTRY_RELEASE; else Bun.env.SENTRY_RELEASE = saved.release;
    if (saved.sha === undefined) delete Bun.env.GITHUB_SHA; else Bun.env.GITHUB_SHA = saved.sha;
  }
});

test("有效 Git 优先于陈旧 metadata，固定仓库 cwd 并拒绝继承 GIT_DIR 或父仓库", () => {
  const f = fixture(), unrelated = fixture();
  mkdirSync(join(f.root, ".git")); mkdirSync(join(unrelated.root, ".git"));
  const revision = "1234567".padEnd(40, "0");
  mkdirSync(join(f.root, "Client/src/data"), { recursive: true });
  writeFileSync(join(f.root, "Client/src/data/changelog.json"), JSON.stringify(changelog));
  putMetadata(f, { schemaVersion: 1, revision: SHA, version: "99.0.0" });
  const cwd = process.cwd(), saved = { dir: Bun.env.GIT_DIR, workTree: Bun.env.GIT_WORK_TREE };
  // 仅替换 Git IO；目录验证、版本选择、优先级和格式化均为真实生产逻辑。
  const git = spyOn(Bun, "spawnSync").mockImplementation(((command: string[], options: { cwd: string; env: Record<string, string> }) => {
    expect(options.cwd).toBe(f.root);
    expect(options.env.GIT_DIR).toBeUndefined(); expect(options.env.GIT_WORK_TREE).toBeUndefined();
    expect(command[0]).toBe("git");
    return { exitCode: 0, stdout: Buffer.from(command.includes("--show-toplevel") ? f.root : revision), stderr: Buffer.alloc(0) };
  }) as any);
  try {
    process.chdir(unrelated.root);
    Bun.env.GIT_DIR = join(unrelated.root, ".git"); Bun.env.GIT_WORK_TREE = unrelated.root;
    expect(resolveServerRelease(f.serverRoot)).toBe("V1.10.0（1234567）");
    rmSync(join(f.root, "Client"), { recursive: true });
    expect(resolveServerRelease(f.serverRoot)).toBeUndefined(); // 有真实修订，无版本，不套陈旧记录。
    const nestedServer = join(f.root, "nested/Server"); mkdirSync(nestedServer, { recursive: true });
    expect(resolveServerRelease(nestedServer)).toBeUndefined(); // 不借父仓库 HEAD 假装自身发布。
    expect(git).toHaveBeenCalledTimes(4);
  } finally {
    process.chdir(cwd); git.mockRestore();
    if (saved.dir === undefined) delete Bun.env.GIT_DIR; else Bun.env.GIT_DIR = saved.dir;
    if (saved.workTree === undefined) delete Bun.env.GIT_WORK_TREE; else Bun.env.GIT_WORK_TREE = saved.workTree;
  }
});

test("stdin 纯元数据脚本可在容器形态运行，不加载 .env/应用，不输出秘密", () => {
  const f = fixture();
  writeFileSync(join(f.root, ".env"), "SENTRY_RELEASE=dummy-release-secret\nSECRET=dummy-private-secret\n");
  const result = runGenerator(f, [SHA, JSON.stringify(changelog)]);
  expect(result.exitCode).toBe(0); expect(result.stderr.toString()).toBe("");
  expect(JSON.parse(result.stdout.toString())).toEqual(buildServerReleaseMetadata(SHA, changelog));
  expect(result.stdout.toString()).not.toContain("secret");

});

const workflowPath = resolve(import.meta.dir, "../../.github/workflows/deploy.yml");
const workflow = readFileSync(workflowPath, "utf8");
const startMarker = "            # ---------- Release 元数据准备（";
const endMarker = "            # ---------- Release 元数据准备结束 ----------";
const releaseStage = workflow.slice(workflow.indexOf(startMarker), workflow.indexOf(endMarker)).split("\n").map(line => line.slice(12)).join("\n");

const runAtomicStage = (f: ReturnType<typeof fixture>, revision: string, input: string) => {
  mkdirSync(join(f.root, "Client/src/data"), { recursive: true });
  mkdirSync(join(f.serverRoot, "src/infrastructure"), { recursive: true });
  writeFileSync(join(f.root, "Client/src/data/changelog.json"), input);
  writeFileSync(join(f.serverRoot, "src/infrastructure/Release.ts"), source);
  const script = `set -euo pipefail\nCOMMIT="$FIXTURE_SHA"\nsay() { echo "$*"; }\nsudo() {\n  [ "$1" = timeout ] && [ "$2" = 3s ] && [ "$3" = docker ] && [ "$4" = exec ] && [ "$5" = -i ] && [ "$6" = BakaGame ] && [ "$7" = /app/node_modules/.bin/bun ] || return 1\n  shift 7\n  timeout 3s "$FIXTURE_BUN" "$@"\n}\n${releaseStage}\nprintf 'after-release\\n' > reached-restart\n`;
  const bash = Bun.which("bash");
  if (!bash) throw new Error("Release shell fixture requires bash (Git Bash on Windows)");
  return Bun.spawnSync([bash, "--noprofile", "--norc", "-c", script], {
    cwd: f.root, stdin: "ignore", env: { ...childEnv(), FIXTURE_SHA: revision, FIXTURE_BUN: process.execPath.replaceAll("\\", "/") },
    stdout: "pipe", stderr: "pipe", timeout: 10_000,
  });
};

test("部署脚本绑定获验 SHA，原子元数据阶段位于维护/重启之前且限时，不依赖宿主 Node/Bun", () => {
  expect(workflow.indexOf(startMarker)).toBeGreaterThan(workflow.indexOf('[ "$COMMIT" = "$DEPLOY_REV" ]'));
  expect(workflow.indexOf(endMarker)).toBeLessThan(workflow.indexOf("# ---------- 4. 停机预告"));
  expect(releaseStage).toContain('sudo timeout 3s docker exec -i BakaGame /app/node_modules/.bin/bun --no-env-file - "$COMMIT"');
  expect(releaseStage).toContain('mv -f "$RELEASE_TMP" Server/build/release.json');
  expect(releaseStage).not.toMatch(/(^|\n)(node|bun) /);
  const f = fixture(); putMetadata(f, { old: "retained-until-success" });
  const result = runAtomicStage(f, SHA, JSON.stringify(changelog));
  expect(result.exitCode).toBe(0);
  expect(JSON.parse(readFileSync(f.metadataPath, "utf8"))).toEqual(buildServerReleaseMetadata(SHA, changelog));
  expect(readdirSync(join(f.serverRoot, "build"))).toEqual(["release.json"]);
  expect(existsSync(join(f.root, "reached-restart"))).toBe(true);
  expect(readFileSync(resolve(import.meta.dir, "../../.gitignore"), "utf8")).toContain("Server/build");
});

for (const [label, revision, input] of [
  ["短 SHA", "abcdef1", JSON.stringify(changelog)], ["损坏 JSON", SHA, "{"], ["无稳定版本", SHA, JSON.stringify({ entries: [] })],
]) {
  test(`部署 ${label} 时保留旧 metadata，失败中止且不进入重启`, () => {
    const f = fixture(); putMetadata(f, { old: "retained" });
    const result = runAtomicStage(f, revision, input);
    expect(result.exitCode).not.toBe(0);
    expect(JSON.parse(readFileSync(f.metadataPath, "utf8"))).toEqual({ old: "retained" });
    expect(readdirSync(join(f.serverRoot, "build"))).toEqual(["release.json"]);
    expect(existsSync(join(f.root, "reached-restart"))).toBe(false);
  });
}
