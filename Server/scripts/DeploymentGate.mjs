// 后端部署门禁。部署分两条路：
//
// - 快速部署：main 推送一到就部署，同时 CI 跑完整检查；后端必过检查不过时，CI 的裁决作业
//   把生产退回上一个获验修订。用来把「推送 → 进入部署」压到半分钟内。
// - 获验部署：推送改了依赖清单或部署链路本身时不走快速部署（这两类出事最难自愈：生产重启
//   不装依赖，部署脚本坏了连回滚都走不通），等 CI 后端必过检查全绿后由裁决作业派发；
//   手动部署与自动回滚也走这条，指定一次 CI 运行，按同一份清单核验。
//
// 清单口径：Server CI 必须真跑过且成功（被路径过滤跳过等于这次没改后端）；
// 其余几道允许因路径过滤被跳过，但不能失败、取消或仍在运行。客户端与壳打包不参与。
export const SERVER_JOB = "Server CI";
export const BACKEND_GATE_JOBS = [
  "Shutdown Smoke",
  "End-to-End Tests",
  "Docs Check",
  "Format Check",
  "Dependency Audit",
  "Knip",
];

// 推送里只要碰到这些文件，就不快速部署，改走获验部署。
const FAST_DEPLOY_BLOCKED_FILES = new Set([
  "package.json",
  "pnpm-lock.yaml",
  "pnpm-workspace.yaml",
  "Server/package.json",
  "Server/.npmrc",
  ".github/workflows/deploy.yml",
  "Server/scripts/DeploymentGate.mjs",
  "Server/scripts/StageNpmLock.mjs",
  "Server/scripts/ExportNpmLock.mjs",
]);
const FAST_DEPLOY_BLOCKED_PREFIXES = ["Server/scripts/Deployment"];

// 比较接口单次最多列 300 个文件，到顶就当作没列全，不冒险快速部署。
const COMPARE_FILE_LIMIT = 300;
const EMPTY_SHA = /^0{40}$/;

const settled = (job, allowSkipped) =>
  job.status !== "in_progress" &&
  job.status !== "queued" &&
  (job.conclusion === "success" || (allowSkipped && job.conclusion === "skipped"));

export function deploymentRevision(run, jobs, repository) {
  if (
    run.path !== ".github/workflows/ci.yml" ||
    run.name !== "CI" ||
    run.event !== "push" ||
    run.head_branch !== "main" ||
    run.head_repository?.full_name !== repository ||
    !/^[0-9a-f]{40}$/.test(run.head_sha ?? "")
  )
    return null;
  const named = (name) => jobs.filter((job) => job.name === name);
  const server = named(SERVER_JOB);
  if (server.length !== 1 || !settled(server[0], false)) return null;
  for (const name of BACKEND_GATE_JOBS) {
    const found = named(name);
    if (found.length !== 1 || !settled(found[0], true)) return null;
  }
  return run.head_sha;
}

/** 变更清单为 null（取不到或没列全）时一律不快速部署。 */
export function fastDeployEligible(files) {
  if (!Array.isArray(files) || files.length === 0) return false;
  return files.every(
    (file) =>
      !FAST_DEPLOY_BLOCKED_FILES.has(file) &&
      !FAST_DEPLOY_BLOCKED_PREFIXES.some((prefix) => file.startsWith(prefix))
  );
}

/** 一次推送改动的文件；新建分支、强推丢了基线或文件列不全时返回 null。 */
export async function pushChangedFiles(github, repo, before, after) {
  if (!before || EMPTY_SHA.test(before)) return null;
  try {
    const { data } = await github.rest.repos.compareCommitsWithBasehead({
      ...repo,
      basehead: `${before}...${after}`,
      per_page: COMPARE_FILE_LIMIT,
    });
    if (data.status !== "ahead") return null;
    const files = (data.files ?? []).map((entry) => entry.filename);
    return files.length >= COMPARE_FILE_LIMIT ? null : files;
  } catch {
    return null;
  }
}

/** 一次 CI 运行的部署结论：后端必过检查全过返回获验 SHA，否则 null。 */
export async function verifiedRevisionOfRun(github, repo, run) {
  const jobs = await github.paginate(github.rest.actions.listJobsForWorkflowRun, {
    ...repo,
    run_id: run.id,
    filter: "latest",
    per_page: 100,
  });
  return deploymentRevision(run, jobs, `${repo.owner}/${repo.repo}`);
}

/**
 * 回滚目标：比当前运行更早、后端必过检查全过的最近一次 main 推送 CI。
 * 每次后端改动的推送都已部署过（快速或获验），所以最近一次获验修订就是上一个好版本。
 */
export async function previousVerifiedRun(github, repo, currentRun, searchLimit = 30) {
  const { data } = await github.rest.actions.listWorkflowRuns({
    ...repo,
    workflow_id: "ci.yml",
    branch: "main",
    event: "push",
    per_page: searchLimit,
  });
  for (const run of data.workflow_runs) {
    if (run.id === currentRun.id || run.created_at >= currentRun.created_at) continue;
    if (await verifiedRevisionOfRun(github, repo, run)) return run;
  }
  return null;
}
