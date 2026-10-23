import { useMemo, useState, type ReactNode } from "react";
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
import {
  creditDependencyIndex,
  type ContributingCompany,
  type CoreTechEntry,
  type CreditDependency,
  type CreditLicenseDocument,
} from "@/lib/Credits";
import { iconTappable } from "@/lib/Motion";
import { cn } from "@/lib/Utils";
import { PRIVACY_UPDATED_AT, PrivacyBody } from "@/components/legal/PrivacyBody";
import { TERMS_UPDATED_AT, TermsBody } from "@/components/legal/TermsBody";
import { ChangelogPanel } from "./ChangelogPanel";
import { CommitPanel } from "./CommitPanel";
import { CreditsPanel } from "./CreditsPanel";
import { DependencySheet } from "./DependencySheet";

export type CreditsTab = "credits" | "changelog" | "commits" | "privacy" | "terms";

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
  { value: "privacy", label: "隐私说明" },
  { value: "terms", label: "用户条款" },
];

/** 法务标签的正文外壳：正文与整页路由共用一份，这里只补「最后更新」与阅读宽度。 */
function LegalTabPanel({ updatedAt, children }: { updatedAt: string; children: ReactNode }) {
  return (
    <article className="mx-auto w-full max-w-3xl px-6 py-5 md:px-10 md:py-6">
      <p className="text-xs text-muted-foreground">{`最后更新：${updatedAt}`}</p>
      <div className="mt-5 space-y-6">{children}</div>
    </article>
  );
}

/** 页眉的纯图标入口：悬停说明给出名称，可访问名与说明同源。 */
function HeaderIconButton({
  label,
  children,
  className,
}: {
  label: string;
  children: ReactNode;
  className?: string;
}) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button
          asChild
          variant="ghost"
          size="icon"
          className={cn("h-8 w-8 shrink-0 text-muted-foreground", className)}
        >
          {children}
        </Button>
      </TooltipTrigger>
      <TooltipContent>{label}</TooltipContent>
    </Tooltip>
  );
}

/**
 * 版本信息页的展示层：固定视口高度的外壳（顶栏 + 标签栏 + 内容区），
 * 只有内容区内部滚动，三段内容再长也不带动整页。
 *
 * 依赖抽屉是二级结构：`path` 保存从主包开始的下钻栈，打开主包是 `[name]`，
 * 点开子依赖 push 一层，返回时 pop；抽屉关闭动画播完（`Sheet` 的 `onExitComplete`）
 * 才清空栈，收起途中内容不会先消失。全量依赖的按名索引由 `creditDependencyIndex` 建一次。
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
  const byName = useMemo(() => creditDependencyIndex(dependencies), [dependencies]);
  const [path, setPath] = useState<string[]>([]);
  const [sheetOpen, setSheetOpen] = useState(false);

  const currentName = path.length > 0 ? path[path.length - 1] : null;
  const currentDependency = currentName ? (byName.get(currentName) ?? null) : null;

  /** 一级行点击：从该主包开始一条新的下钻路径。 */
  const openDependency = (name: string) => {
    setPath([name]);
    setSheetOpen(true);
  };

  /** 子依赖点击：只接受清单里存在的包，避免坏数据把抽屉推到空内容。 */
  const navigateTo = (name: string) => {
    if (byName.has(name)) setPath((previous) => [...previous, name]);
  };

  /** 回到下钻栈的第 `index` 层：路径上的中间格一次跳回，不必逐层退。 */
  const rewindTo = (index: number) => {
    setPath((previous) =>
      index >= 0 && index < previous.length ? previous.slice(0, index + 1) : previous
    );
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
          <h1 className="text-lg font-bold sm:text-xl">关于项目</h1>
          <div className="ml-auto flex min-w-0 items-center gap-2">
            <span className="shrink-0 font-mono text-xs text-muted-foreground">{versionLabel}</span>
            {commitLabel ? (
              <>
                <span
                  aria-hidden="true"
                  className="hidden shrink-0 text-muted-foreground sm:inline"
                >
                  ·
                </span>
                {/* 窄屏省略提交哈希，标题与返回入口保留（Design §7.5）。 */}
                <span className="hidden shrink-0 font-mono text-xs text-muted-foreground sm:inline">
                  {commitLabel}
                </span>
              </>
            ) : null}
            <HeaderIconButton label="GitHub 仓库">
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
            </HeaderIconButton>
          </div>
        </div>
      </header>

      <Tabs
        value={tab}
        onValueChange={(next) => onTabChange(next as CreditsTab)}
        className="flex min-h-0 flex-1 flex-col"
      >
        <div className="shrink-0">
          {/* 窄屏五个标签放不下时整行横向滚动，不折行。 */}
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
              onSelectDependency={openDependency}
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
        {/* 法务两页并入标签：读「关于项目」时不必跳走再跳回，退出还落到主页。 */}
        <TabsContent
          value="privacy"
          className="scrollbar-hidden h-full min-h-0 flex-1 overflow-y-auto overscroll-contain"
        >
          <LegalTabPanel updatedAt={PRIVACY_UPDATED_AT}>
            <PrivacyBody />
          </LegalTabPanel>
        </TabsContent>
        <TabsContent
          value="terms"
          className="scrollbar-hidden h-full min-h-0 flex-1 overflow-y-auto overscroll-contain"
        >
          <LegalTabPanel updatedAt={TERMS_UPDATED_AT}>
            <TermsBody />
          </LegalTabPanel>
        </TabsContent>
      </Tabs>

      <Sheet
        open={sheetOpen}
        onOpenChange={setSheetOpen}
        title={
          currentDependency ? (
            <span className="font-mono">{currentDependency.name}</span>
          ) : (
            "依赖详情"
          )
        }
        onExitComplete={() => {
          // 关闭动画结束后才丢掉下钻栈；若是被重新打开则不丢。
          if (!sheetOpen) setPath([]);
        }}
      >
        {currentDependency ? (
          // 以包名作 key：下钻或返回时状态从头开始，许可证折叠态与加载态不会串到另一个包。
          <DependencySheet
            key={currentDependency.name}
            dependency={currentDependency}
            byName={byName}
            path={path}
            onNavigate={navigateTo}
            onRewind={rewindTo}
            loadLicense={loadLicense}
          />
        ) : null}
      </Sheet>
    </div>
  );
}
