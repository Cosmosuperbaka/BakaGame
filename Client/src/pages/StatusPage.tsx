import { useCallback, useEffect, useState } from "react";
import {
  ArrowLeft,
  CheckCircle2,
  CircleHelp,
  RefreshCw,
  TriangleAlert,
} from "lucide-react";
import {
  PUBLIC_STATUS_COMPONENT_IDS,
  type PublicStatusComponentId,
  type PublicStatusLevel,
  type PublicStatusSnapshot,
} from "@bakagame/shared";
import appVersion from "virtual:app-version";
import { Seo } from "@/components/common/Seo";
import { Badge } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import { usePageNavigate } from "@/hooks/UsePageTransition";
import { formatDateTime } from "@/lib/AdminFormat";
import { fetchSystemStatus } from "@/lib/SystemStatus";

const COMPONENTS: Record<PublicStatusComponentId, { label: string; detail: string }> = {
  service: { label: "游戏服务", detail: "大厅、房间与对局连接" },
  search: { label: "搜索索引", detail: "番剧与角色搜索" },
  dataset: { label: "番剧数据", detail: "番剧、角色与歌曲资料" },
  images: { label: "图片缓存", detail: "封面与头像图片" },
  external: { label: "外部监测", detail: "第三方探针的可用性结果" },
};

type LoadState =
  | { phase: "loading" }
  | { phase: "ready"; snapshot: PublicStatusSnapshot }
  | { phase: "failed" };

function StatusBadge({ level }: { level: PublicStatusLevel }) {
  if (level === "operational") {
    return (
      <Badge variant="matched" size="sm">
        <CheckCircle2 aria-hidden="true" className="h-3 w-3" />
        正常
      </Badge>
    );
  }
  if (level === "degraded") {
    return (
      <Badge variant="restricted" size="sm">
        <TriangleAlert aria-hidden="true" className="h-3 w-3" />
        异常
      </Badge>
    );
  }
  return (
    <Badge variant="subtle" size="sm">
      <CircleHelp aria-hidden="true" className="h-3 w-3" />
      未知
    </Badge>
  );
}

const OVERALL_COPY: Record<"operational" | "degraded" | "unknown", { title: string; detail: string }> = {
  operational: { title: "服务运行正常", detail: "当前没有检测到异常组件。" },
  degraded: { title: "部分服务异常", detail: "下方标记为异常的组件当前不可用或响应异常。" },
  unknown: { title: "暂时无法确认服务状态", detail: "未能连接到后端服务，请稍后刷新重试。" },
};

export default function StatusPage() {
  const navigate = usePageNavigate();
  const [state, setState] = useState<LoadState>({ phase: "loading" });
  const [nonce, setNonce] = useState(0);

  useEffect(() => {
    let alive = true;
    void fetchSystemStatus()
      .then((snapshot) => {
        if (alive) setState({ phase: "ready", snapshot });
      })
      .catch(() => {
        if (alive) setState({ phase: "failed" });
      });
    return () => {
      alive = false;
    };
  }, [nonce]);

  const refresh = useCallback(() => {
    setState({ phase: "loading" });
    setNonce((value) => value + 1);
  }, []);

  const snapshot = state.phase === "ready" ? state.snapshot : undefined;
  const levels = new Map(snapshot?.components.map((component) => [component.id, component.level]));
  const overall = snapshot?.level ?? "unknown";
  const overallCopy = OVERALL_COPY[overall];
  const loading = state.phase === "loading";
  const versionText =
    snapshot && snapshot.version !== "unknown"
      ? snapshot.version
      : snapshot
        ? "未知"
        : appVersion
          ? `V${appVersion}`
          : "未知";

  return (
    <div className="h-full min-h-0 overflow-y-auto overscroll-contain">
      <Seo
        path="/status"
        description="BakaGame 服务状态：查看游戏服务、搜索索引、番剧数据、图片缓存与外部监测的当前可用性。"
        indexable={false}
      />
      <header className="border-b border-border">
        <div className="mx-auto flex w-full max-w-3xl items-center gap-3 px-6 py-3 md:py-4">
          <Button
            variant="ghost"
            size="sm"
            className="-ml-2 h-8 shrink-0 gap-1.5 px-2 text-muted-foreground"
            onClick={() => void navigate("/")}
          >
            <ArrowLeft aria-hidden="true" />
            <span>返回主页</span>
          </Button>
          <h1 className="flex-1 text-lg font-bold sm:text-xl">服务状态</h1>
          <Button
            variant="outline"
            size="sm"
            className="gap-1.5"
            onClick={refresh}
            disabled={loading}
          >
            <RefreshCw aria-hidden="true" className={loading ? "animate-spin" : undefined} />
            刷新
          </Button>
        </div>
      </header>

      <article className="mx-auto w-full max-w-3xl px-6 py-6 md:py-8">
        <section
          aria-live="polite"
          className={
            overall === "degraded"
              ? "rounded-md border border-destructive/40 bg-destructive/10 p-4"
              : overall === "operational"
                ? "rounded-md border border-success/40 bg-success/10 p-4"
                : "rounded-md border border-border bg-muted/40 p-4"
          }
        >
          <div className="flex items-center justify-between gap-3">
            <h2 className="flex items-center gap-2 text-base font-semibold">
              {overall === "operational" ? (
                <CheckCircle2 aria-hidden="true" className="text-success" />
              ) : overall === "degraded" ? (
                <TriangleAlert aria-hidden="true" className="text-destructive" />
              ) : (
                <CircleHelp aria-hidden="true" className="text-muted-foreground" />
              )}
              {loading ? "正在读取服务状态…" : overallCopy.title}
            </h2>
            {!loading && <StatusBadge level={overall} />}
          </div>
          <p className="mt-2 text-sm leading-6 text-muted-foreground">
            {loading
              ? "正在向服务端查询各组件状态，请稍候。"
              : state.phase === "failed"
                ? "页面仍可正常打开，但后端状态接口暂时不可达，无法确认各组件的当前状态。"
                : overallCopy.detail}
          </p>
        </section>

        <ul className="mt-4 divide-y divide-border overflow-hidden rounded-md border bg-card">
          {PUBLIC_STATUS_COMPONENT_IDS.map((id) => (
            <li key={id} className="flex items-center justify-between gap-4 px-4 py-3">
              <div className="min-w-0">
                <div className="text-sm font-medium">{COMPONENTS[id].label}</div>
                <div className="mt-0.5 text-xs text-muted-foreground">{COMPONENTS[id].detail}</div>
              </div>
              <StatusBadge level={levels.get(id) ?? "unknown"} />
            </li>
          ))}
        </ul>

        {levels.get("external") === "unknown" && (
          <p className="mt-3 text-xs text-muted-foreground">
            「未知」表示暂时无法确认，不代表该项一定发生故障；外部监测未接入或暂未取到数据时同样显示为未知。
          </p>
        )}

        <dl className="mt-6 grid gap-2 text-xs text-muted-foreground sm:grid-cols-2">
          <div className="flex gap-2">
            <dt className="shrink-0">版本</dt>
            <dd>
              {versionText}
              {state.phase === "failed" && (
                <span className="ml-1 text-muted-foreground/60">（当前页面版本）</span>
              )}
            </dd>
          </div>
          <div className="flex gap-2">
            <dt className="shrink-0">观测时间</dt>
            <dd>{snapshot ? formatDateTime(snapshot.observedAt) : "—"}</dd>
          </div>
        </dl>

        <p className="mt-4 text-xs text-muted-foreground">
          状态按需探测并短时缓存，页面不会自动刷新；需要最新结果时请手动刷新。
        </p>
      </article>
    </div>
  );
}
