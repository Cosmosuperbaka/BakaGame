import { useEffect, useSyncExternalStore } from "react";
import type { SiteFeatures } from "@bakagame/shared";
import { OPEN_SITE_FEATURES, SITE_FEATURE_KEYS, parseSiteFeatures } from "@bakagame/shared/values";
import { resolveServerUrl } from "@/lib/ServerEndpoint";

export type { SiteFeatures };

/**
 * 站点级功能可见性，服务端 `GET /api/site/config` 现读运行期旋钮。
 *
 * 入口开关是运维止血手段（后台可以临时关掉任一模式），因此这里只做一件事：
 * 把服务端说的「该露哪些入口」搬到页面。读不到、还没回来、字段不合预期一律按**全部开放**处理 ——
 * 一次读失败不该把还能玩的入口藏起来，也不该让开发环境依赖后端才能看到列表。
 *
 * 值只在内存里：同一标签页内多次返回主页不重复请求、也不闪；刷新页面重新问一次。
 */

/** 缺省全开：与服务端未装配该依赖、以及读失败时的口径一致。 */
const OPEN: SiteFeatures = OPEN_SITE_FEATURES;

let snapshot: SiteFeatures = OPEN;
let inflight: Promise<SiteFeatures> | null = null;
const listeners = new Set<() => void>();

/** 失败回 `null`：这一次读不到就沿用上次的值，而不是把已经关掉的入口又亮出来。 */
const request = async (): Promise<SiteFeatures | null> => {
  try {
    const response = await fetch(resolveServerUrl("/api/site/config"));
    if (!response.ok) return null;
    // 只有明确的 false 才关：少字段、类型不对都当开放，避免把「服务端没说清」读成「关掉」。
    return parseSiteFeatures(await response.json());
  } catch {
    return null;
  }
};

const apply = (next: SiteFeatures): void => {
  if (SITE_FEATURE_KEYS.every((key) => next[key] === snapshot[key])) return;
  snapshot = next;
  for (const listener of listeners) listener();
};

/** 一次页面加载只问一次；失败不缓存，下次挂载再试。 */
export const loadSiteFeatures = (): Promise<SiteFeatures> => {
  if (inflight) return inflight;
  const pending = request().then((next) => {
    if (inflight === pending) inflight = null;
    if (next) apply(next);
    return snapshot;
  });
  inflight = pending;
  return pending;
};

const subscribe = (listener: () => void): (() => void) => {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
};

const getSnapshot = (): SiteFeatures => snapshot;

/** 订阅站点功能可见性；首次挂载时去服务端问一次。 */
export const useSiteFeatures = (): SiteFeatures => {
  useEffect(() => {
    void loadSiteFeatures();
  }, []);
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
};

/** 仅供测试：清掉内存里的值，让每个用例从「全开」重新开始。 */
export const resetSiteFeaturesForTest = (): void => {
  snapshot = OPEN;
  inflight = null;
  listeners.clear();
};
