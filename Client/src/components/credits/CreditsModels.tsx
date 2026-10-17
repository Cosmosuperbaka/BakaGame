import { Badge } from "@/components/ui/Badge";
import { sortModelsByRelease, type ContributingCompany } from "@/lib/Credits";
import { CreditBrandMark } from "./CreditsIcons";

/**
 * 参与开发的大模型：按数据文件里的公司顺序分组，组内用 `sortModelsByRelease` 按发布时间从早到晚收口。
 *
 * 公司是一行：左侧厂商 Logo、名称与模型数（弱化），右侧模型徽章流式排列；
 * 窄屏时厂商信息在上、徽章换行在下。整块只有一个描边容器加分隔线，
 * 不再给每家公司套一张等高卡片，避免卡片嵌套与大面积留白。
 * 只展示模型名——`releasedAt` 只用于排序，分工与日期都不上页面（Agents/Credits.md §3）。
 */
export function CreditsModels({ models }: { models: readonly ContributingCompany[] }) {
  return (
    <section aria-labelledby="credits-models-heading">
      <h2 id="credits-models-heading" className="text-base font-semibold">
        参与开发的大模型
      </h2>
      <div className="mt-3 divide-y divide-border overflow-hidden rounded-md border bg-card shadow-2xs">
        {models.map((company) => {
          const sortedModels = sortModelsByRelease(company.models);
          return (
            <div
              key={company.company}
              data-testid={`credits-company-${company.company}`}
              className="flex flex-col gap-2 p-3 sm:flex-row sm:items-start sm:gap-4"
            >
              <div className="flex min-w-0 shrink-0 items-center gap-2 sm:w-56">
                {/* 厂商标识与模型徽章里的家族标识是两枚不同的官方字形，不能互相替代。 */}
                <CreditBrandMark brand={company.logo} className="size-4 shrink-0 text-muted-foreground" />
                <h3 className="min-w-0 truncate text-sm font-semibold">{company.company}</h3>
                <span className="shrink-0 text-2xs text-muted-foreground">{sortedModels.length} 个模型</span>
              </div>
              <ul className="flex min-w-0 flex-wrap gap-1.5">
                {sortedModels.map((model) => (
                  <li key={model.name}>
                    <Badge variant="muted" size="sm">
                      <CreditBrandMark brand={model.logo} className="size-3 shrink-0 text-muted-foreground" />
                      {model.name}
                    </Badge>
                  </li>
                ))}
              </ul>
            </div>
          );
        })}
      </div>
    </section>
  );
}
