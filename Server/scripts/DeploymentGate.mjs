export function deploymentRevision(run, jobs, repository) {
  if (run.path !== '.github/workflows/ci.yml' || run.name !== 'CI' || run.event !== 'push' || run.head_branch !== 'main' ||
      run.head_repository?.full_name !== repository || run.status !== 'completed' ||
      run.conclusion !== 'success' || !/^[0-9a-f]{40}$/.test(run.head_sha ?? '')) return null;
  const server = jobs.filter(job => job.name === 'Server CI');
  return server.length === 1 && server[0].conclusion === 'success' ? run.head_sha : null;
}
