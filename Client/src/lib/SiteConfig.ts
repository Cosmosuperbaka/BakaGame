import { useEffect } from "react";
import type { SiteFeatures } from "@bakagame/shared";
import { OPEN_SITE_FEATURES, SITE_FEATURE_KEYS, parseSiteFeatures } from "@bakagame/shared/values";
import { createExternalStore } from "@/lib/ExternalStore";
import { fetchJson } from "@/lib/HttpJson";
import { createPromiseCache } from "@/lib/PromiseCache";

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

const snapshot = createExternalStore<SiteFeatures>(OPEN);

/** 失败回 `null`：这一次读不到就沿用上次的值，而不是把已经关掉的入口又亮出来。 */
const request = async (): Promise<SiteFeatures | null> => {
  try {
    // 只有明确的 false 才关：少字段、类型不对都当开放，避免把「服务端没说清」读成「关掉」。
    return parseSiteFeatures(await fetchJson("/api/site/config", { label: "站点配置接口" }));
  } catch {
    return null;
  }
};

const apply = (next: SiteFeatures): void => {
  const current = snapshot.get();
  if (SITE_FEATURE_KEYS.every((key) => next[key] === current[key])) return;
  snapshot.set(next);
};

const inflight = createPromiseCache<void, SiteFeatures>(async () => {
  const next = await request();
  inflight.invalidate();
  if (next) apply(next);
  return snapshot.get();
});

/** 一次页面加载只问一次；失败不缓存，下次挂载再试。 */
export const loadSiteFeatures = inflight.get;

/** 订阅站点功能可见性；首次挂载时去服务端问一次。 */
export const useSiteFeatures = (): SiteFeatures => {
  useEffect(() => {
    void loadSiteFeatures();
  }, []);
  return snapshot.use();
};

/** 仅供测试：清掉内存里的值，让每个用例从「全开」重新开始。 */
export const resetSiteFeaturesForTest = (): void => {
  snapshot.write(OPEN);
  inflight.clear();
};
