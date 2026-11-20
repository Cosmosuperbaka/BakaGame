import { reserveSessionRecovery } from "@/lib/SessionRecovery";

/** 分块加载失败自愈的恢复点位：同一会话只自动重载一次。 */
const CHUNK_RECOVERY_KEY = "bakagame:chunk-retry";

/** 自愈重载已经发起：页面马上会重新加载，此后的分块失败与它们的连带错误都不再当真。 */
let reloading = false;

/** 自愈重载是否已经发起。上报与错误界面据此识别「重载前的连带错误」。 */
export const isChunkRecoveryReloading = (): boolean => reloading;

/** 单测重置辅助函数：「重载进行中」是模块级状态，真实页面只会随重载清空。 */
export const resetChunkRecoveryForTest = (): void => {
  reloading = false;
};

/**
 * 页面分块下载失败（发布后旧页面请求已被清掉的哈希文件、边缘节点抖动）重载即可恢复。
 * 构建产物的预加载助手在动态导入或依赖预加载失败时先派发可取消的 `vite:preloadError`，
 * 没人取消才会把错误抛出去。这里在会话级一次性门闩放行时取消它并重载；重载发起后，
 * 同时失败的其它分块也一并取消，等同一次重载。门闩已用过（重载后仍失败）或存储被禁用时
 * 不取消事件，错误照常抛出，由路由错误出口与上报按真实故障处理。
 *
 * 取消的代价是那次动态导入解析成 `undefined`（助手吞掉错误、不返回模块），所以应用里的
 * 动态导入一律经 {@link loadChunk}：重载进行中它把这类导入挂起，不让「取不到成员」的
 * 连带错误冒出来。开发服务器没有预加载助手，因此开发态不自愈。
 *
 * 返回卸载函数（测试用）。
 */
export const installChunkLoadRecovery = (): (() => void) => {
  const onPreloadError = (event: Event) => {
    if (reloading) {
      event.preventDefault();
      return;
    }
    if (!reserveSessionRecovery(CHUNK_RECOVERY_KEY)) return;
    event.preventDefault();
    reloading = true;
    window.location.reload();
  };
  window.addEventListener("vite:preloadError", onPreloadError);
  return () => window.removeEventListener("vite:preloadError", onPreloadError);
};

/**
 * 应用里动态导入的唯一入口：`loadChunk(() => import("..."))`。
 *
 * 平时原样返回模块、原样抛出失败。自愈重载发起之后，被取消的导入解析成 `undefined`，
 * 直接取成员会抛「Cannot read properties of undefined」，被路由错误出口上报并闪出错误界面；
 * 这里改为永远挂起：路由导航停在原页或加载占位上，懒加载组件停在 Suspense 占位上，
 * 直到页面重新加载。重载期间的失败同样挂起，理由相同。
 */
export function loadChunk<T>(load: () => Promise<T>): Promise<T> {
  const pending = new Promise<T>(() => {});
  return load().then(
    (module) => (module === undefined && reloading ? pending : module),
    (error: unknown) => {
      if (reloading) return pending;
      throw error;
    }
  );
}
