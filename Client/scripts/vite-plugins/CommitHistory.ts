/** 构建期把提交历史注入为虚拟模块，随 JS 产物带 hash。 */
import { execSync } from "child_process";
import { REPOSITORY_URL } from "../../src/data/PageMeta.ts";
import {
  COMMIT_HISTORY_LIMIT,
  commitsApiUrl,
  mapGitHubCommits,
  normalizeCommitEntries,
} from "../../src/lib/CommitHistory.ts";
import { type CommitEntry, type CommitHistory } from "../../src/lib/CommitHistory.ts";

// ==================== Vite 插件：构建时注入提交历史 ====================
// 以虚拟模块提供数据，随 JS 产物一同带 hash：
// 落到 public/ 的固定文件名会被 CDN 按不变资源长期缓存，内容更新后前端取不到。
//
// 取数优先走 GitHub 接口而不是 git log：构建容器是浅克隆（depth=1），
// `git log -n 30` 在平台侧只能拿到 HEAD 一条，页脚弹窗里就只剩一行记录。
// 接口取不到时逐级降级回本地 git 日志、再到空数组——任何一步失败都不该让构建挂掉。

const COMMIT_HISTORY_ID = "virtual:commit-history";
/**
 * 只含当前提交号的轻量虚拟模块：首屏（入口、落地页、版本提示）只要这一个值，
 * 不该为它带上整份提交列表。完整列表只给按需加载的致谢页。
 */
const BUILD_INFO_ID = "virtual:build-info";

/** 构建期等接口的硬上限：构建机出网慢时不能把整次构建拖住。 */
const COMMIT_HISTORY_API_TIMEOUT_MS = 3000;

export function commitHistoryPlugin(options: {
  useRemote: boolean;
  /**
   * 读本地 git 的命令入口，默认走 execSync。
   * 抽成参数是为了让降级链（接口失败 → git 日志 → 空数组）能被确定性地测到：
   * 直接调 git 的用例在跑不了子进程的环境里只能整条跳过。
   */
  execGit?: (args: string) => string;
}) {
  const resolvedId = "\0" + COMMIT_HISTORY_ID;
  const resolvedBuildInfoId = "\0" + BUILD_INFO_ID;

  // load 与 transformIndexHtml 都要用，同一次构建里跑一次就够。
  let collected: Promise<CommitHistory> | undefined;

  function runGit(args: string) {
    if (options.execGit) return options.execGit(args);
    return execSync(`git ${args}`, { encoding: "utf-8" }).trim();
  }

  function revision() {
    try {
      return runGit("rev-parse HEAD");
    } catch {
      return "";
    }
  }

  function shortRevision() {
    // 固定截 7 位，与服务端 `Release.ts` 的 release 口径一致：`--short` 在前缀有歧义时会自动加长，
    // 两端就会给同一次构建报出两个不同的 Sentry release。
    // 空串等同取不到：版本提示与 Sentry release 都靠它判断，不能留空值；
    // 非 git 工作区（平台直接给源码包）时退化为占位值，前端据此跳过版本提示。
    return revision().slice(0, 7) || "dev";
  }

  /**
   * 本地 git 日志。浅克隆下只有一条，但作为接口失败后的兜底仍然成立：
   * 一条也比空列表强，何况本地开发跑的是完整历史。
   */
  function collectFromGit(): CommitEntry[] {
    try {
      // 日期取 iso-strict 带时区：--date=short 只到天，相对时间会全部退化成「今天」。
      const raw = runGit("log -n 30 --date=iso-strict --format=%H%x00%s%x00%ad%x00%an%x1F");

      // 用 \x00 分隔字段、\x1F 分隔记录，避开提交信息里的空格与换行。
      const records = raw
        .split("\x1F")
        .map((record) => record.trim())
        .filter(Boolean)
        .map((record) => {
          const parts = record.split("\x00");
          return {
            hash: parts[0] ?? "",
            message: parts[1] ?? "",
            date: parts[2] ?? "",
            author: parts[3] ?? "",
          };
        });

      return normalizeCommitEntries(records);
    } catch {
      return [];
    }
  }

  /** 构建期走 GitHub 接口：数据与远端仓库同源，且不受构建容器的克隆深度影响。 */
  async function collectFromGitHub(revisionSha: string): Promise<CommitEntry[]> {
    const endpoint = commitsApiUrl(REPOSITORY_URL, revisionSha, COMMIT_HISTORY_LIMIT);
    if (!endpoint) return [];

    const headers: Record<string, string> = {
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      "User-Agent": "bakagame-build",
    };
    // 未认证限流按出口 IP 每小时 60 次；构建频率远低于此，Token 只是保险。
    const token = process.env.GITHUB_TOKEN?.trim();
    if (token) headers.Authorization = `Bearer ${token}`;

    try {
      const response = await fetch(endpoint, {
        headers,
        signal: AbortSignal.timeout(COMMIT_HISTORY_API_TIMEOUT_MS),
      });
      if (!response.ok) return [];

      return mapGitHubCommits(await response.json(), COMMIT_HISTORY_LIMIT);
    } catch {
      // 限流、超时、断网、构建提交尚未推送（422）都落这里，交给调用方降级。
      return [];
    }
  }

  async function collect(): Promise<CommitHistory> {
    let commits = options.useRemote ? await collectFromGitHub(revision()) : [];
    if (commits.length === 0) commits = collectFromGit();

    // 不输出版本号：展示版本号一律以 changelog.json 为准，
    // 免得 package.json 与更新日志各说一套。也不写构建时间戳：没有人读它，
    // 却会让同一份提交列表每次构建都得到不同的内容哈希。
    return { currentCommit: shortRevision(), commits };
  }

  return {
    name: "commit-history",
    resolveId(id: string) {
      if (id === COMMIT_HISTORY_ID) return resolvedId;
      return id === BUILD_INFO_ID ? resolvedBuildInfoId : null;
    },
    async load(id: string) {
      // 当前提交号只读本地 git，不等 GitHub 接口：与提交列表第一条、页面 meta 同一个口径。
      if (id === resolvedBuildInfoId) {
        return `export const currentCommit = ${JSON.stringify(shortRevision())};`;
      }
      if (id !== resolvedId) return null;

      collected ??= collect();
      return `export default ${JSON.stringify(await collected)}`;
    },
    transformIndexHtml() {
      // 版本提示靠这个 meta 判断线上是否有新版本，必须与提交列表第一条同源，
      // 所以这里取本地 HEAD，而不是接口返回的最新提交。
      return [
        {
          tag: "meta",
          attrs: {
            name: "bakagame-build",
            content: shortRevision(),
          },
          injectTo: "head" as const,
        },
      ];
    },
  };
}
