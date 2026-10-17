import { useState } from "react";
import { motion } from "framer-motion";
import { ArrowLeft } from "lucide-react";
import { FontAwesomeIcon } from "@fortawesome/react-fontawesome";
// 逐图标引入：品牌图标包的聚合入口无法摇树，整包会进产物。
import { faGithub } from "@fortawesome/free-brands-svg-icons/faGithub";
import { Button } from "@/components/ui/Button";
import { Sheet } from "@/components/ui/Sheet";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/Tabs";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/Tooltip";
import { REPOSITORY_URL } from "@/data/PageMeta";
import type { ChangelogEntry } from "@/lib/Changelog";
import type { CommitEntry } from "@/lib/CommitHistory";
import type {
  ContributingCompany,
  CoreTechEntry,
  CreditDependency,
  CreditLicenseDocument,
} from "@/lib/Credits";
import { iconTappable } from "@/lib/Motion";
import { ChangelogPanel } from "./ChangelogPanel";
import { CommitPanel } from "./CommitPanel";
import { CreditsPanel } from "./CreditsPanel";
import { LicenseSheet } from "./LicenseSheet";

export type CreditsTab = "credits" | "changelog" | "commits";

export interface CreditsViewProps {
  tab: CreditsTab;
  onTabChange: (tab: CreditsTab) => void;
  onBack: () => void;
  versionLabel: string;
  commitLabel: string;
  dependencies: readonly CreditDependency[];
  models: readonly ContributingCompany[];
  techStack: readonly CoreTechEntry[];
  changelogEntries: readonly ChangelogEntry[];
  commits: readonly CommitEntry[];
  loadLicense: (packageName: string) => Promise<CreditLicenseDocument | null>;
}

const TAB_ITEMS: readonly { value: CreditsTab; label: string }[] = [
  { value: "credits", label: "开源致谢" },
  { value: "changelog", label: "更新日志" },
  { value: "commits", label: "提交历史" },
];

/**
 * 版本信息页的展示层：固定视口高度的外壳（顶栏 + 标签栏 + 内容区），
 * 只有内容区内部滚动，三段内容再长也不带动整页。
 *
 * 依赖行的许可证抽屉挂在页面级：选中项一直保留到关闭动画结束
 * （`Sheet` 的 `onExitComplete`）再清空，关闭途中抽屉内容不会先消失。
 */
export function CreditsView({
  tab,
  onTabChange,
  onBack,
  versionLabel,
  commitLabel,
  dependencies,
  models,
  techStack,
  changelogEntries,
  commits,
  loadLicense,
}: CreditsViewProps) {
  const [selected, setSelected] = useState<CreditDependency | null>(null);
  const [licenseOpen, setLicenseOpen] = useState(false);

  const openLicense = (dependency: CreditDependency) => {
    setSelected(dependency);
    setLicenseOpen(true);
  };

  return (
    <div className="flex h-full min-h-0 flex-col overflow-hidden">
      <header className="shrink-0 border-b border-border">
        <div className="mx-auto flex w-full max-w-6xl flex-wrap items-center gap-x-3 gap-y-2 px-6 py-3 md:px-10 md:py-4">
          <Button
            variant="ghost"
            size="sm"
            className="-ml-2 h-8 shrink-0 gap-1.5 px-2 text-muted-foreground"
            onClick={onBack}
          >
            <ArrowLeft aria-hidden="true" />
            <span>返回主页</span>
          </Button>
          <div aria-hidden="true" className="hidden h-4 w-px shrink-0 bg-border sm:block" />
          <h1 className="text-lg font-bold sm:text-xl">开源致谢</h1>
          <div className="ml-auto flex min-w-0 items-center gap-2">
            <span className="shrink-0 font-mono text-xs text-muted-foreground">{versionLabel}</span>
            {commitLabel ? (
              <>
                <span aria-hidden="true" className="hidden shrink-0 text-muted-foreground sm:inline">
                  ·
                </span>
                {/* 窄屏省略提交哈希，标题与返回入口保留（Design §7.5）。 */}
                <span className="hidden shrink-0 font-mono text-xs text-muted-foreground sm:inline">
                  {commitLabel}
                </span>
              </>
            ) : null}
            <Tooltip>
              <TooltipTrigger asChild>
                <Button asChild variant="ghost" size="icon" className="h-8 w-8 shrink-0 text-muted-foreground">
                  <motion.a
                    href={REPOSITORY_URL}
                    target="_blank"
                    rel="noreferrer"
                    aria-label="GitHub 仓库"
                    {...iconTappable}
                  >
                    {/* Font Awesome 的内置样式不进层叠层，尺寸只能经字号给出。 */}
                    <FontAwesomeIcon icon={faGithub} className="text-base" />
                  </motion.a>
                </Button>
              </TooltipTrigger>
              <TooltipContent>GitHub 仓库</TooltipContent>
            </Tooltip>
          </div>
        </div>
      </header>

      <Tabs
        value={tab}
        onValueChange={(next) => onTabChange(next as CreditsTab)}
        className="flex min-h-0 flex-1 flex-col"
      >
        <div className="shrink-0">
          {/* 窄屏三个标签放不下时横向滚动，不折行。 */}
          <div className="scrollbar-hidden mx-auto w-full max-w-6xl overflow-x-auto px-6 md:px-10">
            <TabsList className="w-full justify-start">
              {TAB_ITEMS.map((item) => (
                <TabsTrigger key={item.value} value={item.value}>
                  {item.label}
                </TabsTrigger>
              ))}
            </TabsList>
          </div>
        </div>
        {/* 每个标签自己滚动：切换即从顶部开始，popLayout 的退场内容也不会因公共滚动容器的偏移跳位。 */}
        <TabsContent
          value="credits"
          className="scrollbar-hidden h-full min-h-0 flex-1 overflow-y-auto overscroll-contain"
        >
          <div className="mx-auto w-full max-w-6xl px-6 py-5 md:px-10 md:py-6">
            <CreditsPanel
              dependencies={dependencies}
              models={models}
              techStack={techStack}
              onSelectDependency={openLicense}
            />
          </div>
        </TabsContent>
        <TabsContent
          value="changelog"
          className="scrollbar-hidden h-full min-h-0 flex-1 overflow-y-auto overscroll-contain"
        >
          <div className="mx-auto w-full max-w-6xl px-6 py-5 md:px-10 md:py-6">
            <ChangelogPanel entries={changelogEntries} />
          </div>
        </TabsContent>
        <TabsContent
          value="commits"
          className="scrollbar-hidden h-full min-h-0 flex-1 overflow-y-auto overscroll-contain"
        >
          <div className="mx-auto w-full max-w-6xl px-6 py-5 md:px-10 md:py-6">
            <CommitPanel commits={commits} />
          </div>
        </TabsContent>
      </Tabs>

      <Sheet
        open={licenseOpen}
        onOpenChange={setLicenseOpen}
        title={selected ? <span className="font-mono">{selected.name}</span> : "许可证"}
        onExitComplete={() => {
          // 关闭动画结束后才丢掉选中项；若是被重新打开则不丢。
          if (!licenseOpen) setSelected(null);
        }}
      >
        {selected ? (
          <LicenseSheet key={selected.name} dependency={selected} loadLicense={loadLicense} />
        ) : null}
      </Sheet>
    </div>
  );
}
