import { motion } from "framer-motion";
import { ArrowUpRight } from "lucide-react";
import { Badge } from "@/components/ui/Badge";
import { cn } from "@/lib/Utils";
import {
  sortCompaniesByLetter,
  sortModelsByRelease,
  type ContributingCompany,
  type ContributingModel,
} from "@/lib/Credits";
import { tappable } from "@/lib/Motion";
import { CreditBrandMark } from "./CreditsIcons";

/**
 * 参与开发的大模型：公司按 `sortCompaniesByLetter` 排（英文公司在前按字母、中文公司在后按拼音），
 * 组内用 `sortModelsByRelease` 按发布时间从早到晚收口。两处的展示序都不看数据文件的书写顺序。
 *
 * 公司是一行：左侧厂商 Logo、名称与模型数（弱化），右侧模型徽章流式排列；
 * 窄屏时厂商信息在上、徽章换行在下。整块只有一个描边容器加分隔线，
 * 不再给每家公司套一张等高卡片，避免卡片嵌套与大面积留白。
 *
 * 模型徽章不是纯标签：有发布地址时是可点外链（官方新闻/公告优先，其次官方文档），
 * 新标签打开；确实没有公开页面的模型才退化为静态标签。`releasedAt` 只用于排序，不上页面。
 */
export function CreditsModels({ models }: { models: readonly ContributingCompany[] }) {
  return (
    <section aria-labelledby="credits-models-heading">
      <h2 id="credits-models-heading" className="text-base font-semibold">
        参与开发的大模型
      </h2>
      <div className="mt-3 divide-y divide-border overflow-hidden rounded-md border bg-card shadow-2xs">
        {sortCompaniesByLetter(models).map((company) => {
          const sortedModels = sortModelsByRelease(company.models);
          return (
            <div
              key={company.company}
              data-testid={`credits-company-${company.company}`}
              className="flex flex-col gap-2 p-3 sm:flex-row sm:items-start sm:gap-4"
            >
              <div className="flex min-w-0 shrink-0 items-center gap-2 sm:w-56">
                {/* 厂商标识与模型徽章里的家族标识是两枚不同的官方字形，不能互相替代。 */}
                <CreditBrandMark
                  brand={company.logo}
                  className="size-4 shrink-0 text-muted-foreground"
                />
                <h3 className="min-w-0 truncate text-sm font-semibold">{company.company}</h3>
                <span className="shrink-0 text-2xs text-muted-foreground">
                  {sortedModels.length} 个模型
                </span>
              </div>
              <ul className="flex min-w-0 flex-wrap gap-1.5">
                {sortedModels.map((model) => (
                  <li key={model.name}>
                    <ModelBadge model={model} />
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

/** 与 `Badge variant="muted" size="sm"` 同一套纸面样式；可点击时再叠悬停与按压反馈。 */
const MODEL_BADGE_CLASS =
  "group inline-flex items-center gap-1 rounded-md border border-transparent bg-muted px-1.5 py-px text-xs font-normal text-foreground";

function ModelBadge({ model }: { model: ContributingModel }) {
  const glyph = <CreditBrandMark brand={model.logo} className="size-3 shrink-0" />;
  if (!model.url) {
    return (
      <Badge variant="muted" size="sm">
        {glyph}
        {model.name}
      </Badge>
    );
  }

  return (
    <motion.a
      href={model.url}
      target="_blank"
      rel="noreferrer"
      {...tappable}
      className={cn(
        MODEL_BADGE_CLASS,
        "cursor-pointer transition-colors hover:bg-accent hover:text-accent-foreground focus-visible:-outline-offset-2"
      )}
    >
      {glyph}
      {model.name}
      {/* 外链指示：静止时压淡，悬停沿外链方向挪动并归位到不透明，只作装饰、不承载状态。 */}
      <ArrowUpRight
        className="size-3 shrink-0 opacity-40 transition group-hover:translate-x-0.5 group-hover:-translate-y-0.5 group-hover:opacity-100"
        aria-hidden="true"
      />
    </motion.a>
  );
}
