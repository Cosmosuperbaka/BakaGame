import { afterEach, describe, expect, it, vi } from "vitest";
import { OPEN_SITE_FEATURES } from "@bakagame/shared/values";
import { loadSiteFeatures, resetSiteFeaturesForTest } from "./SiteConfig";

const respond = (body: unknown, ok = true) =>
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => ({ ok, json: async () => body }))
  );

const rankedClosed = { ...OPEN_SITE_FEATURES, ceeRankedEntry: false };

describe("站点功能可见性", () => {
  afterEach(() => {
    resetSiteFeaturesForTest();
    vi.unstubAllGlobals();
  });

  it("服务端说关就关，各模式互不牵连", async () => {
    respond({ ...OPEN_SITE_FEATURES, fakerEntry: false, songSoloEntry: false });
    await expect(loadSiteFeatures()).resolves.toEqual({
      ...OPEN_SITE_FEATURES,
      fakerEntry: false,
      songSoloEntry: false,
    });
  });

  it("字段缺失或类型不对都按开放处理，不把没说清读成关掉", async () => {
    respond({ ceeRankedEntry: "false" });
    await expect(loadSiteFeatures()).resolves.toEqual(OPEN_SITE_FEATURES);
  });

  it("旧服务端只回排位一项时，其余模式照常开放", async () => {
    respond({ ceeRankedEntry: false });
    await expect(loadSiteFeatures()).resolves.toEqual(rankedClosed);
  });

  it("请求失败沿用上次的值：已经关掉的入口不会因为一次读不到又亮出来", async () => {
    respond(rankedClosed);
    await loadSiteFeatures();

    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("offline");
      })
    );
    await expect(loadSiteFeatures()).resolves.toEqual(rankedClosed);
  });

  it("非 2xx 同样按读失败处理，并留给下次挂载重试", async () => {
    respond(rankedClosed, false);
    await expect(loadSiteFeatures()).resolves.toEqual(OPEN_SITE_FEATURES);
    // 失败不留在飞行表里：下一次挂载要能重新问一次。
    respond(rankedClosed);
    await expect(loadSiteFeatures()).resolves.toEqual(rankedClosed);
  });

  it("同一次页面加载只问一次", async () => {
    respond(OPEN_SITE_FEATURES);
    await Promise.all([loadSiteFeatures(), loadSiteFeatures()]);
    expect(fetch).toHaveBeenCalledTimes(1);
  });
});
