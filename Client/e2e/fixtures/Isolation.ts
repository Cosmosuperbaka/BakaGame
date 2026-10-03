import { test as base, type BrowserContext, type BrowserContextOptions } from "@playwright/test";
import { installLoopbackGuard } from "./LoopbackGuard";
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
      try { await guard.drain(); } finally { await context.close(); }
      guard();
    })();
    closing.set(context, operation);
  }
  return operation;
}

type IsolationFixtures = {
  isolatedContext: (options?: BrowserContextOptions) => Promise<BrowserContext>;
};

export const test = base.extend<IsolationFixtures>({
  context: async ({ context }, provide) => {
    await context.grantPermissions(["local-network-access"], { origin: "http://127.0.0.1:5173" });
    const assertNoEgress = await installLoopbackGuard(context);
    guards.set(context, assertNoEgress);
    try {
      await provide(context);
    } finally {
      assertNoEgress();
    }
  },
  page: async ({ context }, provide) => {
    const page = await context.newPage();
    try { await provide(page); } finally { await closeIsolatedContext(context); }
  },
  isolatedContext: async ({ browser }, provide) => {
    const contexts: Array<{ context: BrowserContext; assertNoEgress: () => void }> = [];
    try {
      await provide(async (options = {}) => {
        const context = await browser.newContext({ ...options, serviceWorkers: "block" });
        try {
          await context.grantPermissions(["local-network-access"], { origin: "http://127.0.0.1:5173" });
          const assertNoEgress = await installLoopbackGuard(context);
          guards.set(context, assertNoEgress);
          contexts.push({ context, assertNoEgress });
          return context;
        } catch (error) {
          await context.close();
          throw error;
        }
      });
    } finally {
      try {
        for (const item of contexts) await closeIsolatedContext(item.context);
      } finally {
        for (const item of contexts) item.assertNoEgress();
      }
    }
  },
});

test.use({ serviceWorkers: "block" });
