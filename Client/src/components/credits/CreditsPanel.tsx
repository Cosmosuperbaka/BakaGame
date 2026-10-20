import { SPECIAL_THANKS } from "@/data/CreditsContent";
import type { ContributingCompany, CoreTechEntry, CreditDependency } from "@/lib/Credits";
import { CreditsDependencies } from "./CreditsDependencies";
import { CreditsModels } from "./CreditsModels";
import { CreditsTechStack } from "./CreditsTechStack";
import { CreditsThanks } from "./CreditsThanks";

/**
 * 开源致谢标签：四段固定顺序——参与开发的大模型、核心技术栈、依赖清单、特别鸣谢。
 * 分区标题负责建立层级，不再写说明段；依赖清单一级只展示主包，
 * 点击后由页面打开二级抽屉继续下钻。
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
  /** 打开某个主包的依赖详情，传包名。 */
  onSelectDependency: (name: string) => void;
}) {
  return (
    <div className="space-y-8">
      <CreditsModels models={models} />
      <CreditsTechStack techStack={techStack} dependencies={dependencies} />
      <CreditsDependencies dependencies={dependencies} onSelect={onSelectDependency} />
      <CreditsThanks entries={SPECIAL_THANKS} />
    </div>
  );
}
