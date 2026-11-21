import test from "node:test";
import assert from "node:assert/strict";
import { conditionOf, job, readRepoFile, workflow } from "./support/Workflow.mjs";
import { BACKEND_GATE_JOBS, SERVER_JOB } from "../../scripts/DeploymentGate.mjs";

/**
 * 后端部署派发与部署门禁必须盯同一份检查清单。
 *
 * ci.yml 的 backend-deploy 作业按 needs 结果提前派发部署，Deploy Backend 的门禁再按
 * DeploymentGate.mjs 的作业显示名核一遍。两边各写一份：派发少等一项，会在该项结束前
 * 就派发而被门禁拒掉（部署红）；门禁少查一项，会放过那一项失败的提交。这里把两边钉在一起。
 */

const jobIdByName = new Map(Object.entries(workflow.jobs).map(([id, body]) => [body.name, id]));

const gateJobIds = [SERVER_JOB, ...BACKEND_GATE_JOBS].map((name) => {
  const id = jobIdByName.get(name);
  assert.ok(id, `部署门禁点名的作业「${name}」在 ci.yml 里找不到同名作业`);
  return id;
});

test("派发作业等齐门禁清单里的每一项，且不多等客户端与壳打包", () => {
  const needs = job("backend-deploy").needs;
  assert.deepEqual([...needs].sort(), [...gateJobIds].sort());
});

test("派发条件逐项检查结果：Server CI 必须成功，其余允许跳过但不能失败", () => {
  const condition = conditionOf(job("backend-deploy"));
  assert.match(condition, /!cancelled\(\)/);
  assert.match(condition, /github\.event_name == 'push'/);
  assert.match(condition, /github\.ref == 'refs\/heads\/main'/);
  const serverId = jobIdByName.get(SERVER_JOB);
  assert.match(condition, new RegExp(`needs\\.${serverId}\\.result == 'success'`));
  for (const name of BACKEND_GATE_JOBS) {
    const id = jobIdByName.get(name);
    assert.ok(
      condition.includes(`contains(fromJSON('["success","skipped"]'), needs.${id}.result)`),
      `派发条件缺少对 ${id} 的结果检查`
    );
  }
});

test("部署只由派发触发：不再挂 workflow_run，避免同一提交部署两次", () => {
  const deploy = readRepoFile(".github/workflows/deploy.yml");
  assert.doesNotMatch(deploy, /^\s*workflow_run:/m);
  assert.match(job("backend-deploy").steps.at(-1).run, /gh workflow run deploy\.yml/);
});
