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

beforeEach(() => {
  window.localStorage.clear();
  window.sessionStorage.clear();
});

afterEach(() => {
  cleanup();
  window.localStorage.clear();
  window.sessionStorage.clear();
});

