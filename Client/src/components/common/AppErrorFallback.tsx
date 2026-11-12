import { useEffect } from "react";
import { useRouteError } from "react-router-dom";
import { recoverFromDomInvariant } from "@/lib/DomRecovery";
import { captureClientException } from "@/lib/Sentry";

/** 入口错误边界与路由错误出口共用的回退界面，两处看到的必须是同一份。 */
export function AppErrorFallback() {
  return (
    <div className="flex min-h-screen flex-col items-center justify-center p-6 text-center bg-background text-foreground">
      <h2 className="text-xl font-bold mb-2">哎呀，页面遇到了意料之外的错误</h2>
      <p className="text-sm text-muted-foreground mb-4">异常已自动记录上报，请尝试刷新页面重试。</p>
      <button
        type="button"
        onClick={() => window.location.reload()}
        className="px-4 py-2 rounded-md bg-primary text-primary-foreground font-medium text-sm hover:opacity-90 transition-opacity"
      >
        刷新页面
      </button>
    </div>
  );
}

/**
 * 数据路由的错误出口。路由库会在入口的错误边界之前截住页面渲染错误与分块加载失败，
 * 缺省渲染它自带的报错页且不上报；这里补上与入口一致的上报与 DOM 不变量自愈。
 * 分块加载失败的自愈重载已在 `retryLazyImport` 完成，错误对象上的自愈标记会让上报侧丢弃该事件。
 */
export function RouteErrorFallback() {
  const error = useRouteError();

  useEffect(() => {
    captureClientException(error);
    recoverFromDomInvariant(error);
  }, [error]);

  return <AppErrorFallback />;
}
