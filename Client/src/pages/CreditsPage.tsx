import { useMemo } from "react";
import { useSearchParams } from "react-router-dom";
import { Seo } from "@/components/common/Seo";
import { CreditsView, type CreditsTab } from "@/components/credits/CreditsView";
import changelogData from "@/data/changelog.json";
import { CONTRIBUTING_MODELS, CORE_TECH_STACK } from "@/data/CreditsContent";
import { resolveLatestVersion, sortEntriesByVersion, type ChangelogEntry } from "@/lib/Changelog";
import { loadCreditsLicense } from "@/lib/CreditsLicenseLoader";
import { usePageNavigate } from "@/hooks/UsePageTransition";
import creditsManifest from "virtual:credits";
import commitHistory from "virtual:commit-history";

const TABS: readonly CreditsTab[] = ["credits", "changelog", "commits"];

const isCreditsTab = (value: string | null): value is CreditsTab =>
  value !== null && TABS.includes(value as CreditsTab);

interface ChangelogData {
  entries: ChangelogEntry[];
}

// JSON 直接 import 时结构由内容推断，这里锚定成契约类型，手写日志漏字段会在构建期报错。
const changelog: ChangelogData = changelogData;

/**
 * 版本信息页（`/credits`）：更新日志、提交历史与开源致谢三个标签合成一整页。
 *
 * 数据全部在构建期定型：更新日志来自 `src/data/changelog.json`，提交历史来自
 * `virtual:commit-history`，依赖清单来自 `virtual:credits`；只有许可证原文在打开抽屉时才按桶加载。
 * 标签状态写进 `?tab=`，从页脚版本号进入时默认落在更新日志，直接打开页面时落在开源致谢。
 */
function CreditsPage() {
  const navigate = usePageNavigate();
  const [params, setParams] = useSearchParams();
  const requested = params.get("tab");
  const tab: CreditsTab = isCreditsTab(requested) ? requested : "credits";

  // 与页脚版本号同一口径：取更新日志里的最大版本号，不依赖数组书写顺序。
  const entries = useMemo(() => sortEntriesByVersion(changelog.entries), []);
  const version = useMemo(() => resolveLatestVersion(entries), [entries]);

  return (
    <>
      <Seo path="/credits" />
      <CreditsView
        tab={tab}
        onTabChange={(next) => setParams(next === "credits" ? {} : { tab: next }, { replace: true })}
        onBack={() => navigate("/")}
        versionLabel={`V${version ?? "∞"}`}
        commitLabel={commitHistory.currentCommit}
        dependencies={creditsManifest.dependencies}
        models={CONTRIBUTING_MODELS}
        techStack={CORE_TECH_STACK}
        changelogEntries={entries}
        commits={commitHistory.commits}
        loadLicense={loadCreditsLicense}
      />
    </>
  );
}

export default CreditsPage;
