import {
  expect,
  type BrowserContext,
  type Console,
  type Page,
  type Response,
} from "@playwright/test";

/**
 * 页面质量守卫：把页面异常、控制台错误与非预期 4xx/5xx 收进清单，用例结束统一转红。
 * 默认每个 context 里的每个页面都受保护，豁免只能逐例显式声明。
 *
 * 两处豁免来自隔离夹具本身，不是页面缺陷：
 * - 夹具后端不带数据库，账号（登录、oRPC）与站点统计按设计回 503 `ACCOUNT_DISABLED`，
 *   前端据此隐藏登录入口、游客流程照常；该 503 与其控制台回显一并豁免。
 * - 同一服务连续跑用例会触发遥测端点自身的限流与网关返回，它不影响对局命令；
 *   `/api/monitoring/sentry` 的 429/502/504 与其 429 回显一并豁免。
 * 其余 4xx/5xx 与任何页面异常一律算失败。
 */
export type PageQuality = {
  /** 接管该 context：其中每个页面（含后来新建的）都装上守卫。 */
  watchContext(context: BrowserContext): void;
  /**
   * 静音某个页面的「资源加载失败」回显：用例自己 abort 了本地请求（掐脚本、屏蔽重资源），
   * 这类噪音是被测手段的副产物，不代表页面坏了。
   * 页面异常、其它控制台错误与非预期 4xx/5xx 对这个页面照常生效。
   */
  muteResourceNoise(page: Page): void;
  /** 用例跑完才结算：页面坏了却不转红，正是这套守卫要消灭的事。 */
  assert(): void;
};

export function createPageQuality(): PageQuality {
  const failures = new Map<Page, string[]>();
  const muted = new WeakSet<Page>();

  const watch = (page: Page) => {
    const collected: string[] = [];
    let telemetryDegraded = false;
    let accountLayerDisabled = false;
    const onPageError = (error: Error) => collected.push(`pageerror: ${error.message}`);
    const onConsole = (message: Console) => {
      if (message.type() !== "error") return;
      if (muted.has(page) && message.text().startsWith("Failed to load resource")) return;
      if (telemetryDegraded && message.text().includes("429 (Too Many Requests)")) return;
      if (accountLayerDisabled && message.text().includes("503 (Service Unavailable)")) return;
      collected.push(`console: ${message.text()}`);
    };
    const onResponse = (response: Response) => {
      const { pathname } = new URL(response.url());
      if (
        pathname === "/api/monitoring/sentry" &&
        (response.status() === 429 || response.status() === 502 || response.status() === 504)
      ) {
        if (response.status() === 429) telemetryDegraded = true;
        return;
      }
      if (response.status() === 503 && pathname.startsWith("/api/rpc/")) {
        accountLayerDisabled = true;
        return;
      }
      if (response.status() >= 400) collected.push(`http ${response.status()}: ${response.url()}`);
    };
    page.on("pageerror", onPageError);
    page.on("console", onConsole);
    page.on("response", onResponse);
    // 清单按页面分桶：静音或失败都只影响自己那一页，不连别的页面一起清掉。
    failures.set(page, collected);
  };

  return {
    watchContext: (context) => context.on("page", watch),
    muteResourceNoise: (page) => muted.add(page),
    assert: () => {
      const all = [...failures.values()].flat();
      expect(all, all.join("\n")).toEqual([]);
    },
  };
}
