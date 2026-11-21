// 后端部署门禁：只看「后端上线必须过」的那几道检查，不等客户端、Storybook 与各端壳打包。
// 这几道检查一结束，CI 里的派发作业就会触发部署；CI 其余作业还在跑也不影响判定。
// Server CI 必须真跑过且成功（被路径过滤跳过等于这次没改后端，不部署）；
// 其余几道允许因路径过滤被跳过，但不能失败、取消或仍在运行。
export const SERVER_JOB = "Server CI";
export const BACKEND_GATE_JOBS = [
  "Shutdown Smoke",
  "End-to-End Tests",
  "Docs Check",
  "Format Check",
  "Dependency Audit",
  "Knip",
];

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
