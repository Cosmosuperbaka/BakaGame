import test from "node:test";
import assert from "node:assert/strict";
import { parse } from "yaml";
import { changeFilters, conditionOf, job, readRepoFile, workflow } from "./support/Workflow.mjs";
import { BACKEND_GATE_JOBS, SERVER_JOB } from "../../scripts/DeploymentGate.mjs";

/**
 * 快速部署与 CI 裁决必须对得上。
 *
 * 推送一到 Deploy Backend 就按自己的 push 路径集合快速部署，CI 的裁决作业等后端必过检查
 * 结束后决定保持、补发或回滚。三处各写一份的东西在这里钉在一起：
 * - 部署的 push 路径 = CI 的 server 过滤：部署了却没跑 Server CI，就没有结论可裁决，坏版本会一直留在生产；
 * - 裁决作业的 needs = 门禁清单：少等一项，会在那一项出结果之前就下结论；
 * - 门禁清单点名的作业显示名在 ci.yml 里真实存在：改名后门禁会永远等不到它。
 */

const deployWorkflow = parse(readRepoFile(".github/workflows/deploy.yml"));

const jobIdByName = new Map(Object.entries(workflow.jobs).map(([id, body]) => [body.name, id]));

const gateJobIds = [SERVER_JOB, ...BACKEND_GATE_JOBS].map((name) => {
  const id = jobIdByName.get(name);
  assert.ok(id, `部署门禁点名的作业「${name}」在 ci.yml 里找不到同名作业`);
  return id;
});

test("部署的 push 路径与 CI 的 server 过滤逐条一致", () => {
  const push = deployWorkflow.on?.push;
  assert.deepEqual(push?.branches, ["main"]);
  assert.deepEqual([...push.paths].sort(), [...changeFilters().server].sort());
});

test("部署不再挂 workflow_run：快速部署与 CI 后补发并存会同一提交部署两次", () => {
  assert.equal(deployWorkflow.on?.workflow_run, undefined);
  assert.ok(
    deployWorkflow.on?.workflow_dispatch?.inputs?.ci_run_id,
    "获验部署与回滚要能指定 CI run"
  );
});

test("裁决作业等齐门禁清单里的每一项，且不多等客户端与壳打包", () => {
  const needs = job("backend-deploy").needs;
  assert.deepEqual([...needs].sort(), [...gateJobIds].sort());
});

test("裁决作业只在 main 推送且 Server CI 真跑过时运行，并能派发部署", () => {
  const body = job("backend-deploy");
  const condition = conditionOf(body);
  assert.match(condition, /!cancelled\(\)/);
  assert.match(condition, /github\.event_name == 'push'/);
  assert.match(condition, /github\.ref == 'refs\/heads\/main'/);
  assert.match(
    condition,
    new RegExp(`needs\\.${jobIdByName.get(SERVER_JOB)}\\.result != 'skipped'`)
  );
  assert.equal(body.permissions?.actions, "write");
  const script = body.steps.at(-1).with.script;
  assert.match(script, /createWorkflowDispatch\(\{[^}]*workflow_id: 'deploy\.yml'/);
  assert.match(script, /rollback-of-/);
});
