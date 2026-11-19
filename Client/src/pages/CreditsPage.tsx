import { useMemo } from "react";
import { Navigate, useLocation, useNavigate } from "react-router";
import { AccountDialogs } from "@/components/account/AccountEntry";
import { Seo } from "@/components/common/Seo";
import { CreditsView, type CreditsTab } from "@/components/credits/CreditsView";
import changelogData from "@/data/changelog.json";
import { CONTRIBUTING_MODELS, CORE_TECH_STACK } from "@/data/CreditsContent";
import { resolveLatestVersion, type ChangelogEntry } from "@/lib/Changelog";
import { loadCreditsLicense } from "@/lib/CreditsLicenseLoader";
import { usePageNavigate } from "@/hooks/UsePageTransition";
import { ABOUTS_PATH, aboutsTabHref, aboutsTabOfPath, isAboutsTab } from "@/lib/AboutsTabs";
import creditsManifest from "virtual:credits";
import commitHistory from "virtual:commit-history";

interface ChangelogData {
  entries: ChangelogEntry[];
}

// JSON 直接 import 时结构由内容推断，这里锚定成契约类型，手写日志漏字段会在构建期报错。
const changelog: ChangelogData = changelogData;

/**
 * 关于项目页：开源致谢、更新日志、提交历史、隐私说明与用户条款统一在一个页面。
 *
 * 数据全部在构建期定型：更新日志来自 `src/data/changelog.json`，提交历史来自
 * `virtual:commit-history`，依赖清单来自 `virtual:credits`；只有许可证原文在打开抽屉时才按桶加载。
 * 标签状态写在地址里，规则见 `AboutsTabs`：更新日志、隐私说明、用户条款走独立路径，
 * 开源致谢是 `/abouts` 本身，提交历史挂在 `?tab=` 上。每个标签只认一个规范地址，
 * 其它写法（含指向独立路径标签的 `?tab=`）原地替换成规范地址。
 */
function CreditsPage() {
  const navigate = usePageNavigate();
  // 切标签只换地址不换页：不走页面过渡，也不往历史里堆一条。
  const switchTab = useNavigate();
  const { pathname, search } = useLocation();
  const requested = new URLSearchParams(search).get("tab");

  // 与页脚版本号同一口径：取更新日志里的最大版本号，不依赖数组书写顺序。
  // 条目的排序由更新日志面板负责，这里原样传入。
  const version = useMemo(() => resolveLatestVersion(changelog.entries), []);

  const pathTab = aboutsTabOfPath(pathname);
  const tab: CreditsTab = pathTab ?? (isAboutsTab(requested) ? requested : "credits");
  const canonical = aboutsTabHref(tab);
  if (`${pathname}${search}` !== canonical) {
    return <Navigate to={canonical} replace />;
  }

  return (
    <>
      {/* 有独立路径的标签各用自己的元信息；其余标签收拢到关于页本身。 */}
      <Seo path={pathTab ? pathname : ABOUTS_PATH} />
      <CreditsView
        tab={tab}
        onTabChange={(next) => void switchTab(aboutsTabHref(next), { replace: true })}
        onBack={() => void navigate("/")}
        versionLabel={`V${version ?? "∞"}`}
        commitLabel={commitHistory.currentCommit}
        dependencies={creditsManifest.dependencies}
        models={CONTRIBUTING_MODELS}
        techStack={CORE_TECH_STACK}
        changelogEntries={changelog.entries}
        commits={commitHistory.commits}
        loadLicense={loadCreditsLicense}
      />
      {/* 开源致谢里的声明带反馈入口，弹窗挂在这一页。 */}
      <AccountDialogs />
    </>
  );
}

export default CreditsPage;
