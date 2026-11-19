import { test as base, type BrowserContext, type BrowserContextOptions } from "@playwright/test";
import { installLoopbackGuard, isLoopbackUrl } from "./LoopbackGuard";
import { createPageQuality, type PageQuality } from "./PageQuality";
export { expect } from "@playwright/test";
export { getLoopback, isLoopbackUrl } from "./LoopbackGuard";

type Guard = Awaited<ReturnType<typeof installLoopbackGuard>>;
const guards = new WeakMap<BrowserContext, Guard>();
const closing = new WeakMap<BrowserContext, Promise<void>>();

/** Drain native routing before closing its target; every external attempt still fails. */
export function closeIsolatedContext(context: BrowserContext): Promise<void> {
  let operation = closing.get(context);
  if (!operation) {
    const guard = guards.get(context);
    if (!guard) throw new Error("Unregistered isolated browser context");
    operation = (async () => {
      try {
        await guard.drain();
      } finally {
        await context.close();
      }
      guard();
    })();
    closing.set(context, operation);
  }
  return operation;
}

async function closeAllIsolatedContexts(contexts: BrowserContext[]) {
  const results = await Promise.allSettled(contexts.map(closeIsolatedContext));
  const failures = results.filter(
    (result): result is PromiseRejectedResult => result.status === "rejected"
  );
  if (failures.length)
    throw new AggregateError(
      failures.map((result) => result.reason),
      "Isolated context cleanup failed"
    );
}

async function grantLoopbackAccess(context: BrowserContext, baseURL?: string) {
  const origin = new URL(baseURL ?? "http://127.0.0.1:5173").origin;
  if (!isLoopbackUrl(origin)) throw new Error("Isolated base URL must be loopback");
  await context.grantPermissions(["local-network-access"], { origin });
}

type IsolationFixtures = {
  isolatedContext: (options?: BrowserContextOptions) => Promise<BrowserContext>;
  /** 页面质量守卫：默认接管每个 context 里的每个页面，用例结束统一转红。 */
  pageQuality: PageQuality;
};

export const test = base.extend<IsolationFixtures>({
  // Playwright 要求夹具首参写成解构形式，本夹具不依赖任何其他夹具。
  // eslint-disable-next-line no-empty-pattern
  pageQuality: async ({}, provide) => {
    const quality = createPageQuality();
    await provide(quality);
    quality.assert();
  },
  context: async ({ context, baseURL, pageQuality }, provide) => {
    await grantLoopbackAccess(context, baseURL);
    const assertNoEgress = await installLoopbackGuard(context);
    guards.set(context, assertNoEgress);
    pageQuality.watchContext(context);
    try {
      await provide(context);
    } finally {
      await closeIsolatedContext(context);
    }
  },
  page: async ({ context }, provide) => {
    const page = await context.newPage();
    try {
      await provide(page);
    } finally {
      await closeIsolatedContext(context);
    }
  },
  isolatedContext: async ({ browser, baseURL, pageQuality }, provide) => {
    const contexts: BrowserContext[] = [];
    try {
      await provide(async (options = {}) => {
        const context = await browser.newContext({ ...options, serviceWorkers: "block" });
        try {
          await grantLoopbackAccess(context, baseURL);
          const assertNoEgress = await installLoopbackGuard(context);
          guards.set(context, assertNoEgress);
          pageQuality.watchContext(context);
          contexts.push(context);
          return context;
        } catch (error) {
          await context.close();
          throw error;
        }
      });
    } finally {
      await closeAllIsolatedContexts(contexts);
    }
  },
});

test.use({ serviceWorkers: "block" });
