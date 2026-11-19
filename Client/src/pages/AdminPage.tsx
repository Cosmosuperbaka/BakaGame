import { useState, type ReactNode } from "react";
import { useActiveTabIntoView, useScrollFade } from "@/hooks/UseScrollFade";
import { useSearchParams } from "react-router";
import { ShieldCheck, ShieldOff, type LucideIcon } from "lucide-react";
import { Button } from "@/components/ui/Button";
import { BackToHomeButton } from "@/components/common/BackToHomeButton";
import { Spinner } from "@/components/ui/Spinner";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/Tabs";
import { Seo } from "@/components/common/Seo";
import { LoginDialog } from "@/components/account/LoginDialog";
import { AntiCheatPanel } from "@/components/admin/AntiCheatPanel";
import { AuditPanel } from "@/components/admin/AuditPanel";
import { BangumiMirrorPanel } from "@/components/admin/BangumiMirrorPanel";
import { FeedbackPanel } from "@/components/admin/FeedbackPanel";
import { GamesPanel } from "@/components/admin/GamesPanel";
import { OverviewPanel } from "@/components/admin/OverviewPanel";
import { QQLookupPanel } from "@/components/admin/QQLookupPanel";
import { RoomsPanel } from "@/components/admin/RoomsPanel";
import { RuntimeSettingsPanel } from "@/components/admin/RuntimeSettingsPanel";
import { StatusEventsPanel } from "@/components/admin/StatusEventsPanel";
import { UsersPanel } from "@/components/admin/UsersPanel";
import { usePageNavigate } from "@/hooks/UsePageTransition";
import { useAccountStore } from "@/stores/UseAccountStore";

const TABS = [
  { value: "overview", label: "概览", panel: OverviewPanel },
  { value: "rooms", label: "房间", panel: RoomsPanel },
  { value: "statusEvents", label: "状态事件", panel: StatusEventsPanel },
  { value: "users", label: "用户", panel: UsersPanel },
  { value: "feedback", label: "反馈", panel: FeedbackPanel },
  { value: "anticheat", label: "反作弊复核", panel: AntiCheatPanel },
  { value: "games", label: "对局", panel: GamesPanel },
  { value: "audit", label: "审计", panel: AuditPanel },
  { value: "qq", label: "QQ 查询号", panel: QQLookupPanel },
  { value: "runtime", label: "运行期旋钮", panel: RuntimeSettingsPanel },
  { value: "bangumi", label: "Bangumi 镜像", panel: BangumiMirrorPanel },
] as const;
type TabValue = (typeof TABS)[number]["value"];
const isTab = (value: string | null): value is TabValue => TABS.some((tab) => tab.value === value);

/** 未登录、无权限与账号系统未启用时的居中提示。 */
function Gate({
  title,
  icon: Icon = ShieldCheck,
  children,
}: {
  title: string;
  /** 拒绝类提示用划掉的盾牌：带勾的盾牌读作「已通过」，与「没有权限」「未启用」意思相反。 */
  icon?: LucideIcon;
  children?: ReactNode;
}) {
  return (
    <div className="mx-auto grid max-w-sm justify-items-center gap-3 py-20 text-center">
      <Icon className="h-8 w-8 text-muted-foreground" aria-hidden="true" />
      <h2 className="text-lg font-semibold">{title}</h2>
      {children}
    </div>
  );
}

function AdminTabs() {
  const [params, setParams] = useSearchParams();
  const requested = params.get("tab");
  const tab: TabValue = isTab(requested) ? requested : "overview";
  // 窄屏标签放不下时整行横滑：右缘淡出读得出还有标签；直链进来时当前标签挪进可见范围。
  const [tabScroller, scrollerRef] = useScrollFade<HTMLDivElement>("x");
  useActiveTabIntoView(tabScroller, tab);
  return (
    <Tabs
      value={tab}
      onValueChange={(next) =>
        setParams(next === "overview" ? {} : { tab: next }, { replace: true })
      }
    >
      {/* 窄屏 11 个标签放不下时横向滚动，不折行。 */}
      <div ref={scrollerRef} className="scrollbar-hidden scroll-fade-x mb-6">
        <TabsList className="min-w-full">
          {TABS.map((item) => (
            <TabsTrigger key={item.value} value={item.value}>
              {item.label}
            </TabsTrigger>
          ))}
        </TabsList>
      </div>
      {TABS.map(({ value, panel: Panel }) => (
        <TabsContent key={value} value={value}>
          {value === tab ? <Panel /> : null}
        </TabsContent>
      ))}
    </Tabs>
  );
}

/** 管理后台（`/admin`）：页面本身不设权限，数据全部经服务端按管理员身份校验。 */
function AdminPage() {
  const navigate = usePageNavigate();
  const status = useAccountStore((state) => state.status);
  const role = useAccountStore((state) => state.profile?.role);
  const [loginOpen, setLoginOpen] = useState(false);

  let body: ReactNode;
  if (status === "loading") {
    body = (
      <div role="status" className="flex justify-center py-20">
        <Spinner className="size-5 text-muted-foreground" />
        <span className="sr-only">加载中</span>
      </div>
    );
  } else if (status === "unavailable") {
    body = (
      <Gate title="账号系统未启用" icon={ShieldOff}>
        <p className="text-sm text-muted-foreground">
          管理后台依赖账号系统，当前环境未配置数据库。
        </p>
      </Gate>
    );
  } else if (status === "guest") {
    body = (
      <Gate title="请先登录">
        <p className="text-sm text-muted-foreground">管理后台仅对管理员开放。</p>
        <Button type="button" onClick={() => setLoginOpen(true)}>
          登录
        </Button>
        <LoginDialog open={loginOpen} onOpenChange={setLoginOpen} />
      </Gate>
    );
  } else if (role !== "admin") {
    body = (
      <Gate title="没有访问权限" icon={ShieldOff}>
        <p className="text-sm text-muted-foreground">当前账号不是管理员。</p>
      </Gate>
    );
  } else {
    body = <AdminTabs />;
  }

  return (
    <div className="scrollbar-hidden flex h-full min-h-0 flex-col overflow-x-hidden overflow-y-auto">
      <Seo
        path="/admin"
        title="管理后台 - BakaGame"
        description="BakaGame 管理后台"
        indexable={false}
      />
      <header className="border-b border-border">
        <div className="mx-auto flex w-full max-w-6xl items-center gap-3 px-6 pb-4 pt-6 md:px-10 md:pt-8">
          <BackToHomeButton onClick={() => void navigate("/")} />
          <div className="h-4 w-px shrink-0 bg-border" />
          {/* 与关于页、状态页同构的顶栏，标题同一字号。 */}
          <h1 className="text-lg font-bold sm:text-xl">管理后台</h1>
        </div>
      </header>
      <main className="mx-auto w-full max-w-6xl flex-1 px-6 pb-10 pt-6 md:px-10">{body}</main>
    </div>
  );
}

export default AdminPage;
