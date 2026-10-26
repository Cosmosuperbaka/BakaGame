import "@testing-library/jest-dom/vitest";

import { cleanup } from "@testing-library/react";
import { afterEach, beforeEach } from "vitest";

class MemoryStorage implements Storage {
  private store = new Map<string, string>();

  get length(): number {
    return this.store.size;
  }

  clear(): void {
    this.store.clear();
  }

  getItem(key: string): string | null {
    return this.store.get(key) ?? null;
  }

  key(index: number): string | null {
    return Array.from(this.store.keys())[index] ?? null;
  }

  removeItem(key: string): void {
    this.store.delete(key);
  }

  setItem(key: string, value: string): void {
    this.store.set(key, String(value));
  }
}

const localMemoryStorage = new MemoryStorage();
const sessionMemoryStorage = new MemoryStorage();

Object.defineProperty(window, "localStorage", {
  value: localMemoryStorage,
  configurable: true,
  writable: true,
});
Object.defineProperty(window, "sessionStorage", {
  value: sessionMemoryStorage,
  configurable: true,
  writable: true,
});

if (typeof globalThis.ResizeObserver === "undefined") {
  class ResizeObserver {
    observe() {}
    unobserve() {}
    disconnect() {}
  }
  globalThis.ResizeObserver = ResizeObserver;
}

const ensureCssSupports = () => {
  const css = (typeof window !== "undefined" ? window.CSS : undefined) ?? globalThis.CSS;
  if (!css) {
    const dummy = {
      supports: () => true,
      escape: (s: string) => s,
    } as unknown as typeof CSS;
    globalThis.CSS = dummy;
    if (typeof window !== "undefined") window.CSS = dummy;
  } else {
    if (typeof css.supports !== "function") {
      css.supports = () => true;
    }
    if (typeof css.escape !== "function") {
      css.escape = (s: string) => s;
    }
    if (typeof window !== "undefined") window.CSS = css;
    globalThis.CSS = css;
  }
};
ensureCssSupports();

if (typeof globalThis.MouseEvent === "undefined" && typeof window !== "undefined") {
  globalThis.MouseEvent = window.MouseEvent;
}

if (typeof Element.prototype.scrollIntoView === "undefined") {
  Element.prototype.scrollIntoView = () => {};
}

/**
 * 测试环境不建立真实连接。
 *
 * Node 的全局 WebSocket（undici）会真的去连 `ws://localhost/...`，在 jsdom 里抛
 * 「event 必须是 Event 的实例」这类未捕获异常，而站点通道在根布局一挂载就建连。
 * 这里换成一个永远停在 CONNECTING 的桩；需要断言连接行为的用例自行覆写
 * `globalThis.WebSocket`（`WebsocketClient.test.ts` 就是这么做的）。
 */
class OfflineWebSocket extends EventTarget {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSING = 2;
  static readonly CLOSED = 3;

  readonly CONNECTING = 0;
  readonly OPEN = 1;
  readonly CLOSING = 2;
  readonly CLOSED = 3;
  readyState = 0;
  binaryType = "blob";
  bufferedAmount = 0;
  extensions = "";
  protocol = "";
  url: string;
  onopen: ((event: Event) => void) | null = null;
  onmessage: ((event: MessageEvent) => void) | null = null;
  onclose: ((event: CloseEvent) => void) | null = null;
  onerror: ((event: Event) => void) | null = null;

  constructor(url: string | URL) {
    super();
    this.url = String(url);
  }

  send(): void {}

  close(): void {
    this.readyState = 3;
  }
}

Object.defineProperty(globalThis, "WebSocket", {
  value: OfflineWebSocket,
  configurable: true,
  writable: true,
});
if (typeof window !== "undefined") {
  Object.defineProperty(window, "WebSocket", {
    value: OfflineWebSocket,
    configurable: true,
    writable: true,
  });
}

beforeEach(() => {
  window.localStorage.clear();
  window.sessionStorage.clear();
});

afterEach(() => {
  cleanup();
  window.localStorage.clear();
  window.sessionStorage.clear();
});
