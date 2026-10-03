import { existsSync, readFileSync, realpathSync } from "node:fs";
import { resolve } from "node:path";

export interface ServerReleaseMetadata {
  schemaVersion: 1;
  revision: string;
  version: string;
}

const FULL_REVISION = /^[0-9a-f]{40}$/;
const STABLE_VERSION = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;

export const latestStableVersion = (changelog: unknown): string | undefined => {
  if (!changelog || typeof changelog !== "object" || !("entries" in changelog) || !Array.isArray(changelog.entries)) return undefined;
  const versions = changelog.entries.flatMap((entry: unknown) => {
    if (!entry || typeof entry !== "object" || !("version" in entry)) return [];
    return typeof entry.version === "string" && STABLE_VERSION.test(entry.version) ? [entry.version] : [];
  });
  return versions.sort((left, right) => {
    const a = left.split(".").map(BigInt), b = right.split(".").map(BigInt);
    for (let index = 0; index < 3; index++) {
      if (a[index] !== b[index]) return a[index] > b[index] ? -1 : 1;
    }
    return 0;
  })[0];
};

export const buildServerReleaseMetadata = (revision: unknown, changelog: unknown): ServerReleaseMetadata => {
  if (typeof revision !== "string" || !FULL_REVISION.test(revision)) throw new Error("Release revision 必须是获验的完整 40 位小写 Git SHA");
  const version = latestStableVersion(changelog);
  if (!version) throw new Error("Release changelog 缺少有效稳定 semver");
  return { schemaVersion: 1, revision, version };
};

export const parseServerReleaseMetadata = (value: unknown): ServerReleaseMetadata | undefined => {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  if (Object.keys(record).sort().join(",") !== "revision,schemaVersion,version" || record.schemaVersion !== 1 ||
      typeof record.revision !== "string" || !FULL_REVISION.test(record.revision) ||
      typeof record.version !== "string" || !STABLE_VERSION.test(record.version)) return undefined;
  return { schemaVersion: 1, revision: record.revision, version: record.version };
};

const readJson = (path: string): unknown => {
  try { return JSON.parse(readFileSync(path, "utf8")); }
  catch { return undefined; } // 可选发布证据：缺失或损坏保持 unknown，由初始化显式提示。
};

const sameDirectory = (left: string, right: string): boolean => {
  const a = realpathSync(left), b = realpathSync(right);
  return process.platform === "win32" ? a.toLowerCase() === b.toLowerCase() : a === b;
};

const readGitRevision = (repositoryRoot: string): string | undefined => {
  // clone 与 worktree 均有根 .git（目录或指针文件）；无此证据不向父目录搜索。
  if (!existsSync(resolve(repositoryRoot, ".git"))) return undefined;
  try {
    // 固定源码仓库 cwd，且拒绝父仓库及继承的 GIT_DIR/GIT_WORK_TREE 覆盖。
    const env = { ...process.env };
    for (const key of ["GIT_DIR", "GIT_WORK_TREE", "GIT_COMMON_DIR"]) delete env[key];
    const options = { cwd: repositoryRoot, env, stdin: "ignore" as const, stdout: "pipe" as const, stderr: "pipe" as const, timeout: 2_000 };
    const top = Bun.spawnSync(["git", "rev-parse", "--show-toplevel"], options);
    if (top.exitCode !== 0 || !sameDirectory(top.stdout.toString().trim(), repositoryRoot)) return undefined;
    const head = Bun.spawnSync(["git", "rev-parse", "--verify", "HEAD"], options);
    const revision = head.stdout.toString().trim();
    return head.exitCode === 0 && FULL_REVISION.test(revision) ? revision : undefined;
  } catch { return undefined; } // 支持无 Git 的容器，不将任意环境字符串当作修订证据。
};

export const resolveServerRelease = (serverRoot = resolve(import.meta.dir, "../..")): string | undefined => {
  const repositoryRoot = resolve(serverRoot, "..");
  const revision = readGitRevision(repositoryRoot);
  if (revision) {
    const version = latestStableVersion(readJson(resolve(repositoryRoot, "Client/src/data/changelog.json")));
    // 真实 Git 已确定当前修订但没有版本证据时，不采用可能陈旧的部署记录。
    return version ? `V${version}（${revision.slice(0, 7)}）` : undefined;
  }
  const metadata = parseServerReleaseMetadata(readJson(resolve(serverRoot, "build/release.json")));
  return metadata ? `V${metadata.version}（${metadata.revision.slice(0, 7)}）` : undefined;
};

// 部署可把本文件经 stdin 送入已有容器 Bun；只消费两个公开参数，不导入应用或 .env。
// stdout 仅输出无秘密 JSON，宿主机在同目录临时文件上验证退出码后原子替换。
if (import.meta.main) {
  const [revision, changelogJson, ...extra] = Bun.argv.slice(2);
  if (!revision || !changelogJson || extra.length) throw new Error("Release 元数据脚本需要完整 SHA 与 changelog JSON 两个参数");
  console.log(JSON.stringify(buildServerReleaseMetadata(revision, JSON.parse(changelogJson))));
}
