import { useEffect } from "react";
import { useRouteError } from "react-router";
import { PageLoadingFallback } from "@/components/common/PageLoadingFallback";
import { isChunkRecoveryReloading } from "@/lib/ChunkRecovery";
import { recoverFromDomInvariant } from "@/lib/DomRecovery";
import { captureClientException } from "@/lib/Sentry";

/**
 * 入口错误边界与路由错误出口共用的回退界面，两处看到的必须是同一份。
 * 分块自愈重载进行中显示加载占位而不是报错：页面马上重新加载，此刻的异常只是连带错误。
 */
export function AppErrorFallback() {
  if (isChunkRecoveryReloading()) return <PageLoadingFallback />;
  // data-app-error 是移动壳桥接的判据：出现它说明这一版资源没跑起来，热更新包不会被确认。
  return (
    <div
      data-app-error=""
      className="flex min-h-dvh flex-col items-center justify-center p-6 text-center bg-background text-foreground"
    >
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
 * 能自愈的分块加载失败到不了这里（`ChunkRecovery` 取消事件并重载，`loadChunk` 挂起被取消的导入）；
 * 重载进行中万一仍有连带错误落到这里，不上报、不另做自愈，界面停在加载占位上等重载。
 */
export function RouteErrorFallback() {
  const error = useRouteError();

  useEffect(() => {
    if (isChunkRecoveryReloading()) return;
    captureClientException(error);
    recoverFromDomInvariant(error);
  }, [error]);

  return <AppErrorFallback />;
}
