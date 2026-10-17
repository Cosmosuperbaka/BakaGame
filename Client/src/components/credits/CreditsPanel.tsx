import type { ContributingCompany, CoreTechEntry, CreditDependency } from "@/lib/Credits";
import { CreditsDependencies } from "./CreditsDependencies";
import { CreditsModels } from "./CreditsModels";
import { CreditsTechStack } from "./CreditsTechStack";

/**
 * 开源致谢标签：三段固定顺序——贡献模型、核心技术栈、依赖清单。
 * 上半部分用卡片网格集中展示，依赖清单用紧凑列表承接全部条目，形成主次分层。
 */
export function CreditsPanel({
  dependencies,
  models,
  techStack,
  onSelectDependency,
}: {
  dependencies: readonly CreditDependency[];
  models: readonly ContributingCompany[];
  techStack: readonly CoreTechEntry[];
  onSelectDependency: (dependency: CreditDependency) => void;
}) {
  return (
    <div className="space-y-8">
      <CreditsModels models={models} />
      <CreditsTechStack techStack={techStack} dependencies={dependencies} />
      <CreditsDependencies dependencies={dependencies} onSelect={onSelectDependency} />
    </div>
  );
}
