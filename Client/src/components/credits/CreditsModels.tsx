import { Badge } from "@/components/ui/Badge";
import { sortModelsByRelease, type ContributingCompany } from "@/lib/Credits";

/**
 * 贡献模型：按数据文件里的公司顺序分组，组内用 `sortModelsByRelease` 按发布时间从早到晚收口。
 * 只展示模型名——`releasedAt` 只用于排序，分工与日期都不上页面（Agents/Credits.md §3）。
 * 方徽记取公司首字，给每组一个可扫读的锚点，不引入新的品牌图形。
 */
export function CreditsModels({ models }: { models: readonly ContributingCompany[] }) {
  return (
    <section aria-labelledby="credits-models-heading">
      <h2 id="credits-models-heading" className="text-base font-semibold">
        贡献模型
      </h2>
      <p className="mt-1 max-w-2xl text-sm text-muted-foreground">
        仅记录实际参与项目开发的大模型，按公司与发布时间排列；未实际改动仓库的讨论与评审不在此列。
      </p>
      <div className="mt-3 grid gap-2 sm:grid-cols-2 xl:grid-cols-3">
        {models.map((company) => (
          <div
            key={company.company}
            data-testid={`credits-company-${company.company}`}
            className="rounded-md border bg-card p-3 shadow-2xs"
          >
            <div className="flex items-center gap-2">
              <span
                aria-hidden="true"
                className="flex size-6 shrink-0 items-center justify-center rounded-md bg-muted font-mono text-2xs text-muted-foreground"
              >
                {company.company.slice(0, 1).toUpperCase()}
              </span>
              <h3 className="min-w-0 truncate text-sm font-semibold">{company.company}</h3>
            </div>
            <ul className="mt-2 flex flex-wrap gap-1.5">
              {sortModelsByRelease(company.models).map((model) => (
                <li key={model.name}>
                  <Badge variant="muted" size="sm">
                    {model.name}
                  </Badge>
                </li>
              ))}
            </ul>
          </div>
        ))}
      </div>
    </section>
  );
}
