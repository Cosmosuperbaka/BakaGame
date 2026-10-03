import { isIP } from "node:net";
import { expect, type APIRequestContext, type APIResponse, type BrowserContext } from "@playwright/test";

export function isLoopbackUrl(input: string | URL): boolean {
  const url = new URL(input);
  if (!["http:", "https:", "ws:", "wss:"].includes(url.protocol)) return false;
  const host = url.hostname.replace(/^\[|\]$/g, "");
  return host === "localhost" || host === "::1" || (isIP(host) === 4 && host.startsWith("127."));
}

/** Every attempted external connection is aborted and remains a teardown failure. */
export async function installLoopbackGuard(context: BrowserContext) {
  const failures: string[] = [];
  await context.route("**/*", async (route) => {
    const url = route.request().url();
    if (!isLoopbackUrl(url)) {
      failures.push(`Forbidden HTTP egress: ${url}`);
      await route.abort("blockedbyclient");
      return;
    }
    // Browser routing only sees the first request in an HTTP redirect chain.
    // Fetch locally without following redirects, then fulfill the exact response.
    let response: APIResponse;
    try {
      response = await route.fetch({ maxRedirects: 0 });
    } catch (error) {
      failures.push(`Loopback HTTP failed: ${url}: ${String(error)}`);
      await route.abort("failed");
      return;
    }
    if (response.status() >= 300 && response.status() < 400 && response.headers().location) {
      failures.push(`Forbidden HTTP redirect: ${response.status()} ${url} -> ${response.headers().location}`);
      await route.abort("blockedbyclient");
      return;
    }
    // Terminal handling is not retried: fulfill and abort are mutually exclusive.
    await route.fulfill({ response });
  });
  await context.routeWebSocket("**/*", async (socket) => {
    if (isLoopbackUrl(socket.url())) { socket.connectToServer(); return; }
    failures.push(`Forbidden WebSocket egress: ${socket.url()}`);
    await socket.close({ code: 1008, reason: "E2E only permits loopback" });
  });
  return Object.assign(() => expect(failures, failures.join("\n")).toEqual([]), {
    async drain() {
      // Keep a fail-closed page guard while native unrouteAll waits for context handlers.
      // Removing the context guard without this would briefly reopen external egress.
      for (const page of context.pages()) {
        await page.route("**/*", async (route) => {
          if (!isLoopbackUrl(route.request().url())) failures.push(`Forbidden HTTP egress: ${route.request().url()}`);
          await route.abort("aborted");
        });
      }
      await context.unrouteAll({ behavior: "wait" });
    },
  });
}

/** APIRequestContext bypasses browser routing: validate first, never follow redirects. */
export async function getLoopback(request: APIRequestContext, path: string) {
  const url = new URL(path, "http://127.0.0.1:5173");
  if (!isLoopbackUrl(url)) throw new Error(`Forbidden API HTTP egress: ${url}`);
  const response = await request.get(url.href, { maxRedirects: 0 });
  if (response.status() >= 300 && response.status() < 400) {
    throw new Error(`Unexpected E2E API redirect: ${response.status()} ${url}`);
  }
  return response;
}

