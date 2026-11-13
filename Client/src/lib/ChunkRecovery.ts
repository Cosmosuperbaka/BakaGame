import { reserveSessionRecovery } from "@/lib/SessionRecovery";

/** 分块加载失败自愈的恢复点位：同一会话只自动重载一次。 */
const CHUNK_RECOVERY_KEY = "bakagame:chunk-retry";

/**
 * 页面分块下载失败（发布后旧页面请求已被清掉的哈希文件、边缘节点抖动）重载即可恢复。
 * 构建产物的预加载助手在动态导入或依赖预加载失败时先派发可取消的 `vite:preloadError`，
 * 没人取消才会把错误抛出去。这里在会话级一次性门闩放行时取消它并重载：
 * 错误不再抛出，也就不会上报，页面马上重新加载。门闩已用过（重载后仍失败）或存储被禁用时
 * 不取消事件，错误照常抛出，由路由错误出口与上报按真实故障处理。
 * 开发服务器没有预加载助手，因此开发态不自愈。
 */
export const installChunkLoadRecovery = (): void => {
  window.addEventListener("vite:preloadError", (event) => {
    if (!reserveSessionRecovery(CHUNK_RECOVERY_KEY)) return;
    event.preventDefault();
    window.location.reload();
  });
};
